// AG-051: the demo agent asks the x207 appraiser (backend BE-119) before it prices a listing, and names the appraisal in `detail`.
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair } from "@x207/core";
import { AppraiserClient, AppraiserError, askingTotal, creditUnits, creditsOf, detailWithAppraisal, type Appraisal } from "../shared/appraiser.ts";
import { DEFAULT_BARTER_POLICY, PolicyAgent, type BarterPolicy } from "../shared/barter-policy.ts";
import type { BookClient } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";

const C = (n: number) => String(n * 1_000_000);
const NOW = Math.floor(Date.parse("2026-11-12T10:00:00Z") / 1000);
const ID = "apr_97ee82df1ee83c215bfff67a";

const policy: BarterPolicy = {
  ...DEFAULT_BARTER_POLICY,
  holdings: [{ assetType: "geocode-calls", assetClass: "D", quantity: 10, unitValue: C(10) }],
  needs: [{ assetType: "summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: C(10) }],
};

const appraisal = (value: string, signature = true): Appraisal => ({
  appraisal_id: ID,
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  cached: false,
  result: { value_credits: value, range: { low: value, high: value }, confidence: 0.6, rationale: "test", flags: [] },
  verified: { signature, attestation: "checked" },
});

function identity(): AgentIdentity {
  const keys = generateVoucherKeypair();
  return { accountId: "geocoder.x207.testnet", voucherSecretKey: keys.secretKey, voucherPublicKey: keys.publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "10000000" } };
}

function fakeFetch(answer: () => { status: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const a = answer();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function agent(fetchFn: typeof fetch, posted: unknown[]) {
  const book = { postListing: async (listing: unknown) => { posted.push(listing); return {}; } } as unknown as BookClient;
  return new PolicyAgent({
    identity: identity(), book, contractId: "x207.testnet", policy, now: () => NOW,
    appraiser: {
      client: new AppraiserClient({ baseUrl: "https://backend.test/", fetch: fetchFn }),
      describe: () => ({ scope: "forward geocoding, 1 call = 1 address", provider: "Mapbox", duration_days: 30 }),
    },
  });
}

describe("AG-051 appraiser before pricing", () => {
  it("TC-AG-051-01 the agent appraises the holding, lists at the appraised value and names the appraisal in detail", async () => {
    const f = fakeFetch(() => ({ status: 201, body: appraisal("80") }));
    const posted: unknown[] = [];
    const { listing, appraisal: got } = await agent(f.fn, posted).list();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://backend.test/x207/appraise");
    expect(f.calls[0]!.body).toEqual({
      asset_type: "geocode-calls", asset_class: "D", quantity: 10, market_price_credits: "100",
      scope: "forward geocoding, 1 call = 1 address", provider: "Mapbox", duration_days: 30,
    });
    expect(got?.appraisal_id).toBe(ID);
    expect(listing.offer.value).toBe(C(80));
    expect(listing.detail).toBe(`geocode-calls for summarize-calls | appraisal=${ID}`);
    expect(posted).toEqual([listing]);
  });

  it("TC-AG-051-02 an appraised value far from the owner's total is kept within 50 % of it", async () => {
    const low = await agent(fakeFetch(() => ({ status: 201, body: appraisal("1") })).fn, []).list();
    expect(low.listing.offer.value).toBe(C(50));
    const high = await agent(fakeFetch(() => ({ status: 200, body: appraisal("100000") })).fn, []).list();
    expect(high.listing.offer.value).toBe(C(150));
  });

  it("TC-AG-051-03 an appraisal whose signature was not checked keeps the owner's price but is still named", async () => {
    const { listing } = await agent(fakeFetch(() => ({ status: 201, body: appraisal("80", false) })).fn, []).list();
    expect(listing.offer.value).toBe(C(100));
    expect(listing.detail).toContain(`appraisal=${ID}`);
  });

  it("TC-AG-051-04 when the appraiser fails the listing goes out at the owner's price without an appraisal", async () => {
    const posted: unknown[] = [];
    const out = await agent(fakeFetch(() => ({ status: 503, body: { error: { code: "appraiser_credits_exhausted", message: "no credits" } } })).fn, posted).list();
    expect(out.appraisalError).toBe("appraiser_credits_exhausted");
    expect(out.appraisal).toBeUndefined();
    expect(out.listing.offer.value).toBe(C(100));
    expect(out.listing.detail).toBe("geocode-calls for summarize-calls");
    expect(posted).toHaveLength(1);
  });

  it("TC-AG-051-05 without an appraiser the agent lists exactly as before", async () => {
    const book = { postListing: async () => ({}) } as unknown as BookClient;
    const { listing } = await new PolicyAgent({ identity: identity(), book, contractId: "x207.testnet", policy, now: () => NOW }).list();
    expect(listing.offer.value).toBe(C(100));
    expect(listing.detail).toBe("geocode-calls for summarize-calls");
  });

  it("TC-AG-051-06 credit helpers, asking total and detail tag", async () => {
    expect(creditUnits("15")).toBe(15_000_000n);
    expect(creditUnits("0.000001")).toBe(1n);
    expect(() => creditUnits("1.2345678")).toThrow(/credit amount/);
    expect(creditsOf(100_000_000n)).toBe("100");
    expect(creditsOf(1_500_000n)).toBe("1.5");
    expect(askingTotal(100_000_000n, appraisal("120"))).toEqual({ total: 120_000_000n, used: true });
    expect(askingTotal(100_000_000n, appraisal("120"), 1000)).toEqual({ total: 110_000_000n, used: true });
    expect(askingTotal(100_000_000n, appraisal("120", false))).toEqual({ total: 100_000_000n, used: false });
    expect(detailWithAppraisal("x".repeat(3000), ID)).toHaveLength(2048);
    expect(() => detailWithAppraisal("x", "apr_nope")).toThrow(/appraisal id/);
    const err = new AppraiserError(429, "rate_limited", "slow down");
    expect([err.status, err.code, err.message]).toEqual([429, "rate_limited", "slow down"]);
  });
});
