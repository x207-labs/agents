import { describe, expect, it } from "vitest";
import { ProcurementAgent, readQuote, runProcurement, type ProcurementPolicy } from "../scenario/business.ts";

const enc = (accepts: object[]) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
const requirement = (amount: string) => [
  { scheme: "batch-settlement", network: "x207:agents-main", amount, asset: "USD" },
  { scheme: "exact", network: "near:mainnet", amount: "20000", asset: "USD" },
];

// Mock seller: price per path; a call without a payment header gets 402, a paid call gets 200.
function market(prices: Record<string, string>) {
  const unpaid: string[] = [];
  const paid: string[] = [];
  const respond = (url: string, isPaid: boolean): Response => {
    const path = new URL(url).pathname;
    const price = prices[path];
    if (!price) return new Response("{}", { status: 404 });
    if (!isPaid) {
      unpaid.push(path);
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": enc(requirement(price)) } });
    }
    paid.push(path);
    return new Response(JSON.stringify({ agent: path.slice(5), result: "ok" }), { status: 200 });
  };
  return {
    unpaid, paid,
    quote: (async (input: string | URL | Request) => respond(String(input), false)) as typeof fetch,
    pay: (async (input: string | URL | Request) => respond(String(input), true)) as typeof fetch,
  };
}

const service = (name: string, maxPrice: string) => ({ name, url: "http://seller.test", path: `/api/${name}`, maxPrice });
const policy = (over: Partial<ProcurementPolicy["spend"]> = {}): ProcurementPolicy => ({
  spend: { maxPerCall: "50000", maxPerEpoch: "100000", ...over },
  services: [service("translate", "30000"), service("summarize", "30000"), service("clean", "20000")],
});

describe("AG-020 procurement agent within budget", () => {
  it("TC-AG-020-01 a purchase within limits passes without confirmation and the budget is counted", async () => {
    const m = market({ "/api/translate": "20000", "/api/summarize": "20000", "/api/clean": "10000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: m.pay, quote: m.quote });
    const a = await agent.buy("translate", "hello");
    expect(a).toMatchObject({ ok: true, price: "20000", spentThisEpoch: "20000", status: 200 });
    const b = await agent.buy("clean", "hello");
    expect(b).toMatchObject({ ok: true, spentThisEpoch: "30000" });
    expect(agent.spent).toBe(30_000n);
    expect(m.paid).toEqual(["/api/translate", "/api/clean"]);
  });

  it("TC-AG-020-02 a service outside the owner's list is rejected without touching the seller", async () => {
    const m = market({ "/api/image": "10000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: m.pay, quote: m.quote });
    expect(await agent.buy("image", "hello")).toMatchObject({ ok: false, reason: "service_not_allowed" });
    expect(m.unpaid).toEqual([]);
    expect(m.paid).toEqual([]);
  });

  it("TC-AG-020-03 a price above the service limit or the per-call limit is rejected before paying", async () => {
    const m = market({ "/api/translate": "40000", "/api/summarize": "29000" });
    const strict = policy({ maxPerCall: "25000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: strict, pay: m.pay, quote: m.quote });
    expect(await agent.buy("translate", "hello")).toMatchObject({ ok: false, reason: "price_above_service_limit", detail: { price: "40000", limit: "30000" } });
    expect(await agent.buy("summarize", "hello")).toMatchObject({ ok: false, reason: "over_per_call_limit", detail: { price: "29000", limit: "25000" } });
    expect(m.paid).toEqual([]);
    expect(agent.spent).toBe(0n);
  });

  it("TC-AG-046-01 purchases that run at the same time cannot overshoot the epoch budget, and no redirect is followed (A-AG-11)", async () => {
    const m = market({ "/api/translate": "30000" });
    const seen: Array<RequestInit | undefined> = [];
    const slowPay = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      await new Promise((r) => setTimeout(r, 10));
      return m.pay(input, init);
    }) as typeof fetch;
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy({ maxPerEpoch: "80000" }), pay: slowPay, quote: m.quote });
    const results = await Promise.all(Array.from({ length: 4 }, () => agent.buy("translate", "hello")));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(agent.spent).toBe(60_000n);
    expect(seen.every((init) => init?.redirect === "manual")).toBe(true);
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "http://elsewhere.test/" } })) as typeof fetch;
    const other = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: m.pay, quote: redirect });
    expect(await other.buy("translate", "hello")).toMatchObject({ ok: false, reason: "redirect_refused", detail: { status: "302", step: "quote" } });
  });

  it("TC-AG-046-02 a redirect on the paying request is refused and nothing is counted as spent", async () => {
    const m = market({ "/api/translate": "30000" });
    const payRedirect = (async () => new Response(null, { status: 307, headers: { location: "http://elsewhere.test/" } })) as typeof fetch;
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: payRedirect, quote: m.quote });
    expect(await agent.buy("translate", "hello")).toMatchObject({ ok: false, reason: "redirect_refused", detail: { status: "307", step: "pay" } });
    expect(agent.spent).toBe(0n);
  });

  it("TC-AG-020-04 epoch budget used up: the next purchase is rejected; a new epoch restores the budget", async () => {
    const m = market({ "/api/translate": "30000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy({ maxPerEpoch: "80000" }), pay: m.pay, quote: m.quote });
    const report = await runProcurement(agent, Array.from({ length: 4 }, () => ({ service: "translate", input: "hello" })));
    expect(report).toEqual({ approved: 2, denied: [{ service: "translate", reason: "over_epoch_budget" }, { service: "translate", reason: "over_epoch_budget" }], spent: "60000", budget: "80000" });
    expect(m.paid).toHaveLength(2);
    agent.newEpoch();
    expect(await agent.buy("translate", "hello")).toMatchObject({ ok: true, spentThisEpoch: "30000" });
  });

  it("TC-AG-020-05 without a readable price challenge, there is no payment", async () => {
    const quote = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const noHeader = (async () => new Response("{}", { status: 402 })) as typeof fetch;
    let payCalls = 0;
    const pay = (async () => ((payCalls += 1), new Response("{}", { status: 200 }))) as typeof fetch;
    for (const q of [quote, noHeader]) {
      const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay, quote: q });
      expect(await agent.buy("translate", "hello")).toMatchObject({ ok: false, reason: "quote_unavailable" });
    }
    expect(payCalls).toBe(0);
  });

  it("readQuote reads the x207 batch-settlement entry from the header or the body", async () => {
    const viaHeader = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": enc(requirement("12345")) } });
    expect(await readQuote(viaHeader)).toBe("12345");
    const viaBody = new Response(JSON.stringify({ accepts: requirement("777") }), { status: 402 });
    expect(await readQuote(viaBody)).toBe("777");
    expect(await readQuote(new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "near:mainnet", amount: "5" }] }), { status: 402 }))).toBeNull();
  });
});
