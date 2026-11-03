import { afterEach, describe, expect, it } from "vitest";
import { QUICK_PARAMS, runQuickBarter } from "../scenario/quick.ts";
import { SeekerBot, type VisitedAgent } from "../shared/seeker.ts";
import type { ListingView } from "../shared/barter.ts";
import { acct, BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const C = (n: number) => String(n * 1_000_000);
const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);

describe.skipIf(!BACKEND_AVAILABLE)("AG-018 quick barter and the seeker", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-018-01 both paths give the figures of the note F9 table: pay 93 = 90 + 3, barter cashback 7, Andi bears 10, seeker 3 + 3", async () => {
    market = await startMarketBook(["translator", "summarizer", "scraper", "cleaner", "gpu"], { now: NOW * 1000 });
    const m = market;
    const report = await runQuickBarter({
      book: m.book, contractId: CONTRACT, now: () => NOW,
      identities: { seller: m.identities.translator!, payer: m.identities.summarizer!, barterer: m.identities.scraper!, seeker: m.identities.cleaner!, bystander: m.identities.gpu! },
    });

    expect(QUICK_PARAMS).toEqual({ value: 100, discountBps: 1000, searcherShareBps: 300 });
    expect(report.plans).toEqual([
      { to: acct("scraper"), mode: "barter", listingValue: C(100) },
      { to: acct("summarizer"), mode: "pay", listingValue: C(100) },
    ]);
    // agent yang tidak opt-in tidak pernah dikunjungi
    expect(report.skipped).toEqual([acct("gpu")]);

    // jalur bayar
    expect(report.pay).toMatchObject({ counterpartyPays: C(93), status: "ready" });
    expect(report.pay!.legs.map((l) => [l.to.split(".")[0], l.amount]).sort()).toEqual([["cleaner", C(3)], ["translator", C(90)]]);
    // jalur barter
    expect(report.barter).toMatchObject({ cashback: C(7), sellerBears: C(10), status: "ready" });
    expect(report.barter!.legs.map((l) => `${l.from.split(".")[0]}>${l.to.split(".")[0]}:${Number(l.amount) / 1e6}`).sort()).toEqual([
      "scraper>translator:100", "translator>cleaner:3", "translator>scraper:107",
    ]);
    expect(report.seekerRevenue).toBe(C(6));
  });

  it("TC-AG-018-02 seeker spam fence: opt-in, idle, offer limit per period, rejected pairs, share above the discount", () => {
    const view = (hash: string, over: Partial<ListingView> = {}): ListingView => ({
      listingHash: hash, account: acct("translator"), offer: { assetType: "a", assetClass: "D", quantity: 1, value: C(100) },
      want: { assetType: "b", assetClass: "D", quantity: 1, value: C(100) }, terms: "", detail: "", expiresAt: "2026-11-05T10:00:00Z",
      discountBps: 1000, acceptPayment: true, discoverable: true, nonce: "n", status: "open", ...over,
    });
    const agent = (over: Partial<VisitedAgent> = {}): VisitedAgent => ({ account: acct("summarizer"), optIn: true, idle: true, canPay: true, offers: [], ...over });
    const bot = () => new SeekerBot({ seeker: acct("cleaner"), searcherShareBps: 300, maxOffersPerAgent: 1, periodSeconds: 3600 });
    const listings = [view("a".repeat(64)), view("b".repeat(64))];

    expect(bot().plan(listings, [agent()], NOW)).toHaveLength(1); // limit of one per period
    expect(bot().plan(listings, [agent({ optIn: false })], NOW)).toEqual([]);
    expect(bot().plan(listings, [agent({ idle: false })], NOW)).toEqual([]);
    expect(bot().plan([view("c".repeat(64), { discoverable: false })], [agent()], NOW)).toEqual([]);
    expect(bot().plan([view("d".repeat(64), { discountBps: 200 })], [agent()], NOW)).toEqual([]); // 3% share above a 2% discount
    expect(bot().plan([view("e".repeat(64), { discountBps: 0 })], [agent()], NOW)).toEqual([]);
    expect(bot().plan(listings, [agent({ canPay: false })], NOW)).toEqual([]); // cannot pay and has no holding

    const limited = bot();
    limited.record(acct("summarizer"), NOW - 60);
    expect(limited.plan(listings, [agent()], NOW)).toEqual([]);
    expect(limited.plan(listings, [agent()], NOW + 3600)).toHaveLength(1); // periode berikutnya
    const refusing = bot();
    refusing.refuse(acct("summarizer"), "a".repeat(64));
    expect(refusing.plan(listings, [agent()], NOW).map((p) => p.listing.listingHash)).toEqual(["b".repeat(64)]);
  });
});

describe.skipIf(!BACKEND_AVAILABLE)("AG-018 seeker referral: inbox and rejection", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-018-03 an agent without opt-in rejects with a signature and the seeker cannot refer that pair again", async () => {
    market = await startMarketBook(["translator", "summarizer", "cleaner"], { now: NOW * 1000 });
    const m = market;
    const { DEFAULT_BARTER_POLICY, PolicyAgent } = await import("../shared/barter-policy.ts");
    const make = (name: string, policy: any) => new PolicyAgent({ identity: m.identities[name]!, book: m.book, contractId: CONTRACT, policy, now: () => NOW });
    const seller = make("translator", { ...DEFAULT_BARTER_POLICY, holdings: [{ assetType: "a", assetClass: "D", quantity: 1, unitValue: C(100) }], needs: [{ assetType: "b", assetClass: "D", quantity: 1, maxUnitValue: C(100) }] });
    const target = make("summarizer", { ...DEFAULT_BARTER_POLICY, acceptReferrals: false, needs: [{ assetType: "a", assetClass: "D", quantity: 1, maxUnitValue: C(100) }] });
    const seeker = make("cleaner", DEFAULT_BARTER_POLICY);
    const { hash } = await seller.list();
    const [listing] = await m.book.listings({ status: "open" });
    const plan = { to: acct("summarizer"), listing: listing!, mode: "pay" as const, value: listing!.offer.value, quantity: 1 };

    const sent = await seeker.sendReferral(plan, 300);
    expect(sent).toMatchObject({ status: "pending", listingHash: hash, searcherShareBps: 300 });
    expect(await target.handleReferrals()).toEqual([{ referralHash: sent.referralHash, action: "refused", reason: "not_opted_in" }]);
    expect(await m.book.referralInbox(acct("summarizer"))).toEqual([]);
    await expect(seeker.sendReferral(plan, 300)).rejects.toMatchObject({ code: "referral_refused" });
  });
});
