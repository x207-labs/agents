import { afterEach, describe, expect, it } from "vitest";
import { listingHash } from "@x207/core";
import { DEFAULT_BARTER_POLICY, PolicyAgent, buildListing, decide, decideRule, matchesPolicy, type BarterPolicy, type DecisionContext } from "../shared/barter-policy.ts";
import type { LlmClient } from "../shared/nearai.ts";
import { acct, BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const C = (n: number) => String(n * 1_000_000);
const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);

// Angka kebijakan contoh: nilai listing 100, lantai terima 90, tolak di bawah 50, pembuka 85, langkah 5.
const sellerPolicy: BarterPolicy = {
  ...DEFAULT_BARTER_POLICY,
  holdings: [{ assetType: "translate-calls", assetClass: "D", quantity: 10, unitValue: C(10) }],
  needs: [{ assetType: "summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: C(10) }],
};
const buyerPolicy: BarterPolicy = {
  ...DEFAULT_BARTER_POLICY,
  holdings: [{ assetType: "summarize-calls", assetClass: "D", quantity: 10, unitValue: C(10) }],
  needs: [{ assetType: "translate-calls", assetClass: "D", quantity: 10, maxUnitValue: "9200000" }],
};
const listingSides = {
  offer: { asset_type: "translate-calls", asset_class: "D", quantity: 10, value: C(100) },
  want: { asset_type: "summarize-calls", asset_class: "D", quantity: 10, value: C(100) },
} as const;
const ctx = (over: Partial<DecisionContext> & { value?: string; round?: number; mode?: "pay" | "barter" } = {}): DecisionContext => ({
  role: over.role ?? "seller",
  listing: { ...listingSides, accept_payment: true, expires_at: NOW + 3600 },
  offer: { round: over.round ?? 1, mode: over.mode ?? "barter", value: over.value ?? C(85), quantity: 10 },
  policy: over.role === "buyer" ? buyerPolicy : sellerPolicy,
  now: NOW,
  ...(over.ownLastValue ? { ownLastValue: over.ownLastValue } : {}),
});

describe("AG-016 decision rules (mock mode)", () => {
  it("the seller accepts above floor 90, counters between 50 and 90, rejects below 50", () => {
    expect(decideRule(ctx({ value: C(90) }))).toEqual({ action: "accept" });
    expect(decideRule(ctx({ value: C(97) }))).toEqual({ action: "accept" });
    expect(decideRule(ctx({ value: C(85) }))).toEqual({ action: "counter", value: C(95) });
    expect(decideRule(ctx({ value: C(40) }))).toEqual({ action: "reject", reason: "too_low" });
  });

  it("the seller never counters below the floor and the concession rises per round", () => {
    expect(decideRule(ctx({ value: C(80), round: 3 }))).toEqual({ action: "counter", value: C(95) });
    expect(decideRule(ctx({ value: C(80), round: 5 }))).toEqual({ action: "counter", value: C(90) });
    expect(decideRule(ctx({ value: C(80), round: 6 }))).toEqual({ action: "reject", reason: "max_rounds" });
  });

  it("rejections: pay without accept_payment, expired listing, amount above the listing", () => {
    const c = ctx({ mode: "pay" });
    expect(decideRule({ ...c, listing: { ...c.listing, accept_payment: false } })).toEqual({ action: "reject", reason: "payment_not_accepted" });
    expect(decideRule({ ...c, listing: { ...c.listing, expires_at: NOW } })).toEqual({ action: "reject", reason: "listing_expired" });
    expect(decideRule({ ...c, offer: { ...c.offer, quantity: 11 } })).toEqual({ action: "reject", reason: "quantity_exceeds_listing" });
  });

  it("the bidder accepts below ceiling 92, raises the offer per round up to the ceiling, rejects at the round limit", () => {
    expect(decideRule(ctx({ role: "buyer", value: C(92), round: 2 }))).toEqual({ action: "accept" });
    expect(decideRule(ctx({ role: "buyer", value: C(95), round: 2, ownLastValue: C(85) }))).toEqual({ action: "counter", value: C(90) });
    expect(decideRule(ctx({ role: "buyer", value: C(95), round: 4, ownLastValue: C(90) }))).toEqual({ action: "counter", value: C(92) });
    expect(decideRule(ctx({ role: "buyer", value: C(95), round: 6, ownLastValue: C(92) }))).toEqual({ action: "reject", reason: "max_rounds" });
  });
});

describe("AG-016 LLM mode obeys the policy", () => {
  const llm = (answer: string, mode: LlmClient["mode"] = "live"): LlmClient & { calls: number } => {
    const client = { mode, model: "m", calls: 0, async complete() { client.calls += 1; return answer; } };
    return client;
  };

  it("mock mode does not call the model", async () => {
    const fake = llm('{"action":"accept"}', "mock");
    expect(await decide(ctx({ value: C(85) }), fake)).toMatchObject({ action: "counter", source: "rule" });
    expect(fake.calls).toBe(0);
  });

  it("a valid model proposal is used", async () => {
    const reply = `ok: {"action":"counter","value":"${C(93)}"}`;
    expect(await decide(ctx({ value: C(85) }), llm(reply))).toEqual({ action: "counter", value: C(93), source: "llm" });
  });

  it("a proposal that breaks the floor or is malformed is discarded", async () => {
    expect(await decide(ctx({ value: C(85) }), llm('{"action":"accept"}'))).toMatchObject({ action: "counter", value: C(95), source: "rule" });
    expect(await decide(ctx({ value: C(85) }), llm(`{"action":"counter","value":"${C(60)}"}`))).toMatchObject({ source: "rule" });
    expect(await decide(ctx({ value: C(85) }), llm("I do not know"))).toMatchObject({ action: "counter", source: "rule" });
    expect(await decide(ctx({ value: C(85) }), llm('{"action":"dance"}'))).toMatchObject({ source: "rule" });
  });
});

describe("AG-016 listing from a holding and a need", () => {
  const identity = { accountId: acct("translator"), voucherSecretKey: "ed25519:x", voucherPublicKey: "ed25519:y", policy: { maxPerCall: "1", maxPerEpoch: "1" } } as const;

  it("value = unit price × quantity and the parameters follow the policy", () => {
    const listing = buildListing({ identity: { ...identity, voucherSecretKey: "ed25519:x" }, contractId: CONTRACT, policy: sellerPolicy, now: NOW, nonce: "n 1" });
    expect(listing).toMatchObject({
      account: acct("translator"), offer: { asset_type: "translate-calls", quantity: 10, value: C(100) }, want: { asset_type: "summarize-calls", value: C(100) },
      discount_bps: 1000, accept_payment: true, discoverable: true, expires_at: NOW + 86_400, nonce: "n-1",
    });
    expect(listingHash(listing)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("without a holding or a need, or with class X, fails", () => {
    const args = { identity, contractId: CONTRACT, now: NOW, nonce: "n" };
    expect(() => buildListing({ ...args, policy: DEFAULT_BARTER_POLICY })).toThrow(/no holding/);
    expect(() => buildListing({ ...args, policy: { ...sellerPolicy, needs: [] } })).toThrow(/no need/);
    expect(() => buildListing({ ...args, policy: { ...sellerPolicy, holdings: [{ assetType: "plan", assetClass: "X" as "A", quantity: 1, unitValue: "1" }] } })).toThrow(/asset class X/);
  });

  it("matchesPolicy: barter when the agent has what the listing seeks, pay when not, null for its own listing", () => {
    const view = { account: acct("translator"), offer: { assetType: "translate-calls", assetClass: "D", quantity: 10, value: C(100) }, want: { assetType: "summarize-calls", assetClass: "D", quantity: 10, value: C(100) } };
    expect(matchesPolicy(view, acct("summarizer"), buyerPolicy)).toBe("barter");
    expect(matchesPolicy(view, acct("summarizer"), { ...buyerPolicy, holdings: [] })).toBe("pay");
    expect(matchesPolicy(view, acct("translator"), buyerPolicy)).toBeNull();
    expect(matchesPolicy({ ...view, offer: { ...view.offer, assetType: "other" } }, acct("summarizer"), buyerPolicy)).toBeNull();
  });
});

describe.skipIf(!BACKEND_AVAILABLE)("AG-016 two-agent negotiation through the book", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-016-01 listing, offer 85, counter 95, counter 90, accepted becomes a bundle signed by both sides", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: NOW * 1000 });
    const m = market;
    const make = (name: string, policy: BarterPolicy) => new PolicyAgent({ identity: m.identities[name]!, book: m.book, contractId: CONTRACT, policy, now: () => NOW });
    const andi = make("translator", sellerPolicy);
    const budi = make("summarizer", buyerPolicy);

    const { hash } = await andi.list();
    expect((await m.book.listings())).toHaveLength(1);

    const bids = await budi.shop();
    expect(bids).toMatchObject([{ kind: "bid", mode: "barter", value: C(85) }]);
    expect(await budi.shop()).toEqual([]); // does not bid twice

    const r2 = await andi.handleInbox();
    expect(r2).toMatchObject([{ kind: "countered", round: 2, value: C(95) }]);
    const r3 = await budi.handleInbox();
    expect(r3).toMatchObject([{ kind: "countered", round: 3, value: C(90) }]);
    const r4 = await andi.handleInbox();
    expect(r4).toMatchObject([{ kind: "accepted", listingHash: hash, result: { result: { kind: "bundle" } } }]);

    expect((await m.book.listings({ status: "matched" })).map((l) => l.listingHash)).toEqual([hash]);
    expect(await budi.signProposals()).toEqual([{ termsHash: expect.any(String), action: "signed" }]);
    const [proposal] = await m.book.proposals(acct("summarizer"), "ready");
    expect(proposal).toMatchObject({ status: "ready", missing: [], listingHash: hash });
    // nilai kesepakatan 90 (bukan 100 di listing): Budi membayar 90 ke Andi; Andi membayar 100 + cashback 9 (diskon 10% dari 90)
    const leg = (payer: string, payee: string) => proposal!.terms.legs.find((l) => l.payer === acct(payer) && l.payee === acct(payee))?.max_amount;
    expect(leg("summarizer", "translator")).toBe(C(90));
    expect(leg("translator", "summarizer")).toBe(C(109));
  });

  it("TC-AG-016-02 an offer far below the floor is rejected by the seller without a counter", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: NOW * 1000 });
    const m = market;
    const andi = new PolicyAgent({ identity: m.identities.translator!, book: m.book, contractId: CONTRACT, policy: sellerPolicy, now: () => NOW });
    const budi = new PolicyAgent({ identity: m.identities.summarizer!, book: m.book, contractId: CONTRACT, policy: { ...buyerPolicy, openingBps: 3000 }, now: () => NOW });
    await andi.list();
    await budi.shop();
    expect(await andi.handleInbox()).toMatchObject([{ kind: "rejected", reason: "too_low" }]);
  });

  it("TC-AG-016-03 a proposal with terms different from the negotiation is not signed", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: NOW * 1000 });
    const m = market;
    const make = (name: string, policy: BarterPolicy) => new PolicyAgent({ identity: m.identities[name]!, book: m.book, contractId: CONTRACT, policy, now: () => NOW });
    const andi = make("translator", sellerPolicy);
    const budi = make("summarizer", { ...buyerPolicy, needs: [{ ...buyerPolicy.needs[0]!, maxUnitValue: C(10) }] });
    await andi.list();
    await budi.shop();
    await andi.handleInbox();
    expect((await budi.handleInbox())[0]).toMatchObject({ kind: "accepted" });
    // syarat diganti diam-diam di buku (stand-in pihak jahat): leg pertama dinaikkan
    const row = m.db.prepare("SELECT id, terms_json, terms_hash FROM bundle_proposals").get() as { id: number; terms_json: string };
    const terms = JSON.parse(row.terms_json);
    terms.legs[0].max_amount = String(BigInt(terms.legs[0].max_amount) + 1n);
    m.db.prepare("UPDATE bundle_proposals SET terms_json = ? WHERE id = ?").run(JSON.stringify(terms), row.id);
    const answers = await andi.signProposals();
    expect(answers).toMatchObject([{ action: "rejected", reason: "terms_differ_from_negotiation" }]);
  });
});
