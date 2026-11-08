import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, listingHash, planOffer, type Listing, type Offer } from "@x207/core";
import { DEFAULT_BARTER_POLICY, PolicyAgent, buyerCeiling, decide, type BarterPolicy, type DecisionContext } from "../shared/barter-policy.ts";
import type { BookClient, ListingView, OfferView, ReferralView } from "../shared/barter.ts";
import type { LlmClient } from "../shared/nearai.ts";
import type { AgentIdentity } from "../shared/identity.ts";

// AG-035 (A-AG-01), AG-036 (A-AG-02), AG-037 (A-AG-03): the owner's ceiling holds on every path, and the agent does not sign legs that the backend made up. No model is called (mock client).
const C = (n: number) => String(n * 1_000_000);
const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);
const CONTRACT = "x207-v017.testnet";
const buyer: BarterPolicy = {
  ...DEFAULT_BARTER_POLICY,
  acceptReferrals: true,
  holdings: [{ assetType: "summarize-calls", assetClass: "D", quantity: 10, unitValue: C(10) }],
  needs: [{ assetType: "translate-calls", assetClass: "D", quantity: 10, maxUnitValue: "9200000" }], // ceiling for 10 units = 92 credit
};
const listingBase: ListingView = {
  listingHash: "", account: "seller.testnet",
  offer: { assetType: "translate-calls", assetClass: "D", quantity: 10, value: C(100) },
  want: { assetType: "summarize-calls", assetClass: "D", quantity: 10, value: C(100) },
  terms: "t", detail: "d", expiresAt: new Date((NOW + 3600) * 1000).toISOString(), discountBps: 0, acceptPayment: true, discoverable: true, nonce: "n1", status: "open",
};
const toListing = (v: ListingView): Listing => ({
  circle: CONTRACT, account: v.account,
  offer: { asset_type: v.offer.assetType, asset_class: "D", quantity: v.offer.quantity, value: v.offer.value },
  want: { asset_type: v.want.assetType, asset_class: "D", quantity: v.want.quantity, value: v.want.value },
  terms: v.terms, detail: v.detail, expires_at: Math.floor(Date.parse(v.expiresAt) / 1000), discount_bps: v.discountBps, accept_payment: v.acceptPayment, discoverable: v.discoverable, nonce: v.nonce,
});
const listingView: ListingView = { ...listingBase, listingHash: listingHash(toListing(listingBase)) };
const keys = generateVoucherKeypair();
const identity = (account: string): AgentIdentity => ({ accountId: account, voucherSecretKey: keys.secretKey, voucherPublicKey: keys.publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "10000000" } });
const referral = (over: Partial<ReferralView>): ReferralView => ({
  referralHash: "r1", seeker: "seeker.testnet", to: "buyer.testnet", listingHash: listingView.listingHash, mode: "pay", value: C(92), quantity: 10,
  deliverBy: "x", searcherShareBps: 0, expiresAt: "x", status: "open", offerHash: null, ...over,
});

function stubBook(over: Record<string, unknown>) {
  const calls = { offers: [] as Array<{ value: string; quantity: number }>, refused: [] as string[], accepted: [] as unknown[] };
  const book = {
    listings: async () => [listingView],
    referralInbox: async () => [],
    refuseReferral: async (hash: string) => { calls.refused.push(hash); return {}; },
    postOffer: async (listingHash: string, offer: Offer) => { calls.offers.push({ value: offer.value, quantity: offer.quantity }); return { offerHash: "o-new", round: offer.round } as unknown as OfferView; },
    offersOf: async () => [],
    inbox: async () => [],
    previewAccept: async () => ({ epoch: 3 }),
    accept: async (...args: unknown[]) => { calls.accepted.push(args); return {}; },
    ...over,
  } as unknown as BookClient;
  return { book, calls };
}

describe("AG-035 A-AG-01 referral bids stay under the ceiling and the need", () => {
  const agent = (book: BookClient) => new PolicyAgent({ identity: identity("buyer.testnet"), book, contractId: CONTRACT, policy: buyer, now: () => NOW });

  it("TC-AG-035-01 a referral at the ceiling is bid; above the ceiling, a bad value, or more units than needed is refused", async () => {
    const cases: Array<[Partial<ReferralView>, "bid" | string]> = [
      [{ value: C(92) }, "bid"],
      [{ value: C(93) }, "over_ceiling"],
      [{ value: C(100) }, "over_ceiling"],
      [{ value: "0" }, "over_ceiling"],
      [{ value: "1.5" }, "over_ceiling"],
      [{ value: C(92), quantity: 11 }, "quantity_over_need"],
      [{ value: C(92), quantity: 0 }, "quantity_over_need"],
    ];
    for (const [over, expected] of cases) {
      const { book, calls } = stubBook({ referralInbox: async () => [referral(over)] });
      const [answer] = await agent(book).handleReferrals();
      if (expected === "bid") {
        expect(answer).toMatchObject({ action: "bid" });
        expect(calls.offers).toEqual([{ value: C(92), quantity: 10 }]);
      } else {
        expect(answer).toMatchObject({ action: "refused", reason: expected });
        expect(calls.offers).toEqual([]);
        expect(calls.refused).toEqual(["r1"]);
      }
    }
  });

  it("TC-AG-035-02 bidFromReferral refuses a plan above the ceiling or with too many units", async () => {
    const { book, calls } = stubBook({});
    const a = agent(book);
    await expect(a.bidFromReferral({ listing: listingView, mode: "pay", value: C(100), quantity: 10 })).rejects.toThrow(/bid_over_ceiling/);
    await expect(a.bidFromReferral({ listing: listingView, mode: "pay", value: C(90), quantity: 12 })).rejects.toThrow(/bid_quantity_over_need/);
    expect(calls.offers).toEqual([]);
    await expect(a.bidFromReferral({ listing: listingView, mode: "pay", value: C(90), quantity: 10 })).resolves.toMatchObject({ kind: "bid" });
  });
});

describe("AG-036 A-AG-02 a model counter cannot lift the buyer above its ceiling", () => {
  const ctx = (): DecisionContext => ({
    role: "buyer",
    listing: { offer: { asset_type: "translate-calls", asset_class: "D", quantity: 10, value: C(100) }, want: { asset_type: "summarize-calls", asset_class: "D", quantity: 10, value: C(100) }, accept_payment: true, expires_at: NOW + 3600 },
    offer: { round: 2, mode: "pay", value: C(97), quantity: 10 },
    policy: buyer, now: NOW, ownLastValue: C(85),
  });

  it("TC-AG-036-01 buyerCeiling is min(need ceiling, listed value); a live counter above it is dropped for the rule", async () => {
    expect(buyerCeiling(buyer, ctx().listing.offer)).toBe(92_000_000n);
    const llm: LlmClient = { mode: "live", complete: async () => JSON.stringify({ action: "counter", value: C(99) }) } as unknown as LlmClient;
    const out = await decide(ctx(), llm);
    expect(out.source).toBe("rule");
    expect(out).toEqual({ action: "counter", value: C(90), source: "rule" });
    const ok: LlmClient = { mode: "live", complete: async () => JSON.stringify({ action: "counter", value: C(91) }) } as unknown as LlmClient;
    expect((await decide(ctx(), ok)).source).toBe("llm");
  });
});

describe("AG-037 A-AG-03 the agent signs only the bundle that its own planOffer gives", () => {
  const seller: BarterPolicy = { ...DEFAULT_BARTER_POLICY, holdings: [{ assetType: "translate-calls", assetClass: "D", quantity: 10, unitValue: C(10) }], needs: [] };
  const offerView: OfferView = {
    offerHash: "bb".repeat(32), listingHash: listingView.listingHash, proposer: "buyer.testnet", counterparty: "buyer.testnet", awaiting: "seller.testnet",
    round: 1, mode: "barter", value: C(95), quantity: 10, deliverBy: new Date((NOW + 86_400) * 1000).toISOString(), status: "open",
  };
  const offer: Offer = { circle: CONTRACT, listing_hash: listingView.listingHash, proposer: "buyer.testnet", round: 1, mode: "barter", value: C(95), quantity: 10, deliver_by: NOW + 86_400 };
  const real = planOffer({ listing: toListing(listingView), offer, epoch: 3, counterparty: "buyer.testnet" });

  function agentWith(bundle: unknown) {
    const { book, calls } = stubBook({
      inbox: async () => [{ ...offerView }],
      offersOf: async () => [{ ...offerView }],
      previewAccept: async () => ({ epoch: 3, bundle }),
    });
    return { agent: new PolicyAgent({ identity: identity("seller.testnet"), book, contractId: CONTRACT, policy: seller, now: () => NOW }), calls };
  }

  it("TC-AG-037-01 the bundle that equals the local plan is signed; legs with another payee or amount are not signed", async () => {
    expect(real.kind).toBe("bundle");
    if (real.kind !== "bundle") return;
    const honest = agentWith({ terms: real.terms, termsHash: real.terms_hash });
    const [done] = await honest.agent.handleInbox();
    expect(done?.kind).toBe("accepted");
    expect(honest.calls.accepted).toHaveLength(1);

    // the backend changes the payee of the first leg to an account it controls and keeps terms and hash consistent with each other
    const { termsHash: hashOf } = await import("@x207/core");
    const forged = { ...real.terms, legs: real.terms.legs.map((leg, i) => (i === 0 ? { ...leg, payee: "thief.testnet" } : leg)) };
    const bad = agentWith({ terms: forged, termsHash: hashOf(forged) });
    await expect(bad.agent.handleInbox()).rejects.toThrow(/bundle_differs_from_local_plan/);
    expect(bad.calls.accepted).toHaveLength(0);

    const bigger = { ...real.terms, legs: real.terms.legs.map((leg, i) => (i === 0 ? { ...leg, max_amount: String(BigInt(leg.max_amount) + 1n) } : leg)) };
    const bad2 = agentWith({ terms: bigger, termsHash: hashOf(bigger) });
    await expect(bad2.agent.handleInbox()).rejects.toThrow(/bundle_differs_from_local_plan/);
    expect(bad2.calls.accepted).toHaveLength(0);
  });
});
