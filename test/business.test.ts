import { describe, expect, it } from "vitest";
import { ProcurementAgent, readQuote, runProcurement, type ProcurementPolicy } from "../scenario/business.ts";

const enc = (accepts: object[]) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
const requirement = (amount: string) => [
  { scheme: "batch-settlement", network: "x207:agents-main", amount, asset: "USD" },
  { scheme: "exact", network: "near:mainnet", amount: "20000", asset: "USD" },
];

// Penjual tiruan: harga per jalur; panggilan tanpa header pembayaran mendapat 402, panggilan berbayar mendapat 200.
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

describe("AG-020 agent pengadaan dalam anggaran", () => {
  it("TC-AG-020-01 pembelian dalam batas lolos tanpa konfirmasi dan anggaran terhitung", async () => {
    const m = market({ "/api/translate": "20000", "/api/summarize": "20000", "/api/clean": "10000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: m.pay, quote: m.quote });
    const a = await agent.buy("translate", "halo");
    expect(a).toMatchObject({ ok: true, price: "20000", spentThisEpoch: "20000", status: 200 });
    const b = await agent.buy("clean", "halo");
    expect(b).toMatchObject({ ok: true, spentThisEpoch: "30000" });
    expect(agent.spent).toBe(30_000n);
    expect(m.paid).toEqual(["/api/translate", "/api/clean"]);
  });

  it("TC-AG-020-02 jasa di luar daftar pemilik ditolak tanpa menyentuh penjual", async () => {
    const m = market({ "/api/image": "10000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay: m.pay, quote: m.quote });
    expect(await agent.buy("image", "halo")).toMatchObject({ ok: false, reason: "service_not_allowed" });
    expect(m.unpaid).toEqual([]);
    expect(m.paid).toEqual([]);
  });

  it("TC-AG-020-03 harga di atas batas jasa atau batas per panggilan ditolak sebelum membayar", async () => {
    const m = market({ "/api/translate": "40000", "/api/summarize": "29000" });
    const strict = policy({ maxPerCall: "25000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: strict, pay: m.pay, quote: m.quote });
    expect(await agent.buy("translate", "halo")).toMatchObject({ ok: false, reason: "price_above_service_limit", detail: { price: "40000", limit: "30000" } });
    expect(await agent.buy("summarize", "halo")).toMatchObject({ ok: false, reason: "over_per_call_limit", detail: { price: "29000", limit: "25000" } });
    expect(m.paid).toEqual([]);
    expect(agent.spent).toBe(0n);
  });

  it("TC-AG-020-04 anggaran epoch habis: pembelian berikutnya ditolak; epoch baru memulihkan anggaran", async () => {
    const m = market({ "/api/translate": "30000" });
    const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy({ maxPerEpoch: "80000" }), pay: m.pay, quote: m.quote });
    const report = await runProcurement(agent, Array.from({ length: 4 }, () => ({ service: "translate", input: "halo" })));
    expect(report).toEqual({ approved: 2, denied: [{ service: "translate", reason: "over_epoch_budget" }, { service: "translate", reason: "over_epoch_budget" }], spent: "60000", budget: "80000" });
    expect(m.paid).toHaveLength(2);
    agent.newEpoch();
    expect(await agent.buy("translate", "halo")).toMatchObject({ ok: true, spentThisEpoch: "30000" });
  });

  it("TC-AG-020-05 tanpa tantangan harga yang terbaca, tidak ada pembayaran", async () => {
    const quote = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const noHeader = (async () => new Response("{}", { status: 402 })) as typeof fetch;
    let payCalls = 0;
    const pay = (async () => ((payCalls += 1), new Response("{}", { status: 200 }))) as typeof fetch;
    for (const q of [quote, noHeader]) {
      const agent = new ProcurementAgent({ account: "gpu.x207-circle.near", policy: policy(), pay, quote: q });
      expect(await agent.buy("translate", "halo")).toMatchObject({ ok: false, reason: "quote_unavailable" });
    }
    expect(payCalls).toBe(0);
  });

  it("readQuote membaca entri batch-settlement x207 dari header atau badan", async () => {
    const viaHeader = new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": enc(requirement("12345")) } });
    expect(await readQuote(viaHeader)).toBe("12345");
    const viaBody = new Response(JSON.stringify({ accepts: requirement("777") }), { status: 402 });
    expect(await readQuote(viaBody)).toBe("777");
    expect(await readQuote(new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "near:mainnet", amount: "5" }] }), { status: 402 }))).toBeNull();
  });
});
