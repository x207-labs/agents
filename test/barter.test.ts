import { afterEach, describe, expect, it } from "vitest";
import { intentHash, intentHashBase58, termsHash, type BarterIntent, type BundleTerms } from "@x207/core";
import { BarterAgent, evaluateProposal } from "../shared/barter.ts";
import { acct, BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const C = (n: number) => String(n * 1_000_000);
const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);
const side = (service: string, value = 100) => ({ service, calls: 10, value: C(value) });

// Cincin A -> B -> C -> A: tiap agent menyediakan satu jasa dan membutuhkan jasa agent berikutnya (nilai seimbang).
const RING = [
  { name: "translator", offer: side("translate"), need: side("summarize") },
  { name: "summarizer", offer: side("summarize"), need: side("scrape") },
  { name: "scraper", offer: side("scrape"), need: side("translate") },
] as const;
const ringTerms = (epoch = 42, amounts = [100, 100, 100]): BundleTerms => ({
  circle: CONTRACT,
  epoch,
  legs: [
    // pembayar membayar penyedia jasa yang ia butuhkan: A bayar B, B bayar C, C bayar A
    { payer: acct("translator"), payee: acct("summarizer"), max_amount: C(amounts[0]!) },
    { payer: acct("summarizer"), payee: acct("scraper"), max_amount: C(amounts[1]!) },
    { payer: acct("scraper"), payee: acct("translator"), max_amount: C(amounts[2]!) },
  ],
});

describe.skipIf(!BACKEND_AVAILABLE)("AG-012 intent offer/need dan usulan bundle", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  async function setup() {
    market = await startMarketBook(RING.map((r) => r.name), { now: NOW * 1000 });
    const agents = new Map(
      RING.map((r) => [r.name, new BarterAgent({ identity: market!.identities[r.name]!, book: market!.book, contractId: CONTRACT, now: () => NOW })]),
    );
    return { m: market, agents };
  }

  it("TC-AG-012-01 tiga agent memasang intent; buku menyimpan dan hash cocok", async () => {
    const { m, agents } = await setup();
    for (const r of RING) {
      const { intent, view } = await agents.get(r.name)!.postIntent(r.offer, r.need);
      expect(view.intentHash).toBe(intentHash(intent));
      expect(view.onchain.args).toEqual(agents.get(r.name)!.postIntentArgs(intent));
      expect(view.onchain.args.intent_hash).toBe(intentHashBase58(intent));
    }
    const open = await m.book.listIntents("open");
    expect(open.map((i) => i.account)).toEqual(RING.map((r) => acct(r.name)));
    expect(open[0]).toMatchObject({ offer: RING[0].offer, need: RING[0].need });
  });

  it("TC-AG-012-02 usulan yang cocok dengan intent ditandatangani semua agent sampai ready", async () => {
    const { m, agents } = await setup();
    for (const r of RING) await agents.get(r.name)!.postIntent(r.offer, r.need);
    const hash = await m.injectProposal(ringTerms());
    for (const r of RING) {
      const answers = await agents.get(r.name)!.answerProposals();
      expect(answers).toEqual([{ termsHash: hash, action: "signed" }]);
    }
    const [proposal] = await m.book.proposals(acct("translator"), "ready");
    expect(proposal).toMatchObject({ termsHash: hash, status: "ready", missing: [] });
    // jawaban kedua tidak menandatangani ulang
    expect(await agents.get("translator")!.answerProposals()).toEqual([]);
  });

  it("TC-AG-012-03 usulan yang tidak cocok ditolak dan tidak ditandatangani", async () => {
    const { m, agents } = await setup();
    for (const r of RING) await agents.get(r.name)!.postIntent(r.offer, r.need);
    // translator harus membayar 120 padahal kebutuhannya bernilai 100
    const overpay = await m.injectProposal(ringTerms(42, [120, 100, 100]));
    expect(await agents.get("translator")!.answerProposals()).toEqual([{ termsHash: overpay, action: "rejected", reason: "overpay" }]);
    // summarizer menerima 120 dan membayar 100: cocok
    expect(await agents.get("summarizer")!.answerProposals()).toEqual([{ termsHash: overpay, action: "signed" }]);
    const [proposal] = await m.book.proposals(acct("translator"), "proposed");
    expect(proposal!.missing).toEqual([acct("translator"), acct("scraper")].sort());

    // agent yang menerima kurang dari nilai penawarannya menolak
    const underpaid = await m.injectProposal(ringTerms(42, [100, 100, 80]));
    const answers = await agents.get("translator")!.answerProposals();
    expect(answers.find((a) => a.termsHash === underpaid)).toEqual({ termsHash: underpaid, action: "rejected", reason: "underpaid" });
  });

  it("TC-AG-012-05 signTerms: tanda tangan untuk syarat yang cocok, null untuk yang tidak (permintaan langsung solver)", async () => {
    const { m, agents } = await setup();
    for (const r of RING) await agents.get(r.name)!.postIntent(r.offer, r.need);
    const translator = agents.get("translator")!;
    const good = await translator.signTerms(ringTerms());
    expect(good).toMatchObject({ account: acct("translator") });
    const { verifyBundleSignature } = await import("@x207/core");
    expect(verifyBundleSignature(ringTerms(), good!.signature, m.identities.translator!.voucherPublicKey)).toBe(true);
    expect(await translator.signTerms(ringTerms(42, [120, 100, 100]))).toBeNull(); // membayar lebih dari kebutuhan
    expect(await translator.signTerms(ringTerms(41))).toBeNull(); // bukan epoch open
  });

  it("TC-AG-012-06 solver mengirim usulan lewat POST bundle-proposals dan agent menandatanganinya sampai ready", async () => {
    const { m, agents } = await setup();
    for (const r of RING) await agents.get(r.name)!.postIntent(r.offer, r.need);
    const created = await m.book.postBundleProposal(ringTerms());
    expect(created).toMatchObject({ status: "proposed", epoch: 42, listingHash: null });
    for (const r of RING) expect(await agents.get(r.name)!.answerProposals()).toEqual([{ termsHash: created.termsHash, action: "signed" }]);
    const [ready] = await m.book.proposals(acct("translator"), "ready");
    expect(ready).toMatchObject({ termsHash: created.termsHash, status: "ready", missing: [] });
    await expect(m.book.postBundleProposal(ringTerms(41))).rejects.toMatchObject({ code: "epoch_not_open" });
  });

  it("TC-AG-012-04 epoch bukan epoch open ditolak", async () => {
    const { m, agents } = await setup();
    for (const r of RING) await agents.get(r.name)!.postIntent(r.offer, r.need);
    const stale = await m.injectProposal(ringTerms(41));
    expect(await agents.get("scraper")!.answerProposals()).toEqual([{ termsHash: stale, action: "rejected", reason: "epoch_mismatch" }]);
  });
});

describe("AG-012 evaluateProposal", () => {
  const intent = (over: Partial<BarterIntent> = {}): BarterIntent => ({
    circle: CONTRACT, account: acct("translator"), offer: side("translate"), need: side("summarize"), expiresAt: NOW + 600, nonce: "n1", ...over,
  });
  const check = (terms: BundleTerms, intents: BarterIntent[], over: Partial<Parameters<typeof evaluateProposal>[0]> = {}, hash = termsHash(terms)) =>
    evaluateProposal({ account: acct("translator"), proposal: { termsHash: hash, terms }, intents, now: NOW, ...over });

  it("cocok: menerima sebesar offer dan membayar sebesar need", () => {
    expect(check(ringTerms(), [intent()])).toEqual({ ok: true, intentHash: intentHash(intent()) });
    expect(check(ringTerms(42, [90, 100, 150]), [intent()])).toMatchObject({ ok: true });
  });

  it("hash yang tidak sama dengan hasil hitung syarat ditolak", () => {
    expect(check(ringTerms(), [intent()], {}, "0".repeat(64))).toEqual({ ok: false, reason: "terms_hash_mismatch" });
  });

  it("alasan penolakan: bukan peserta, epoch, tanpa intent, intent kedaluwarsa, lingkaran, tanpa leg", () => {
    expect(check(ringTerms(), [intent()], { account: acct("gpu") })).toEqual({ ok: false, reason: "not_participant" });
    expect(check(ringTerms(41), [intent()], { openEpoch: 42 })).toEqual({ ok: false, reason: "epoch_mismatch" });
    expect(check(ringTerms(41), [intent()], { openEpoch: null })).toMatchObject({ ok: true });
    expect(check(ringTerms(), [])).toEqual({ ok: false, reason: "no_open_intent" });
    expect(check(ringTerms(), [intent({ expiresAt: NOW })])).toEqual({ ok: false, reason: "no_open_intent" });
    expect(check(ringTerms(), [intent({ circle: "other.near" })])).toEqual({ ok: false, reason: "wrong_circle" });
    const onlyPays: BundleTerms = {
      circle: CONTRACT, epoch: 42,
      legs: [{ payer: acct("translator"), payee: acct("summarizer"), max_amount: C(100) }, { payer: acct("summarizer"), payee: acct("scraper"), max_amount: C(100) }],
    };
    expect(check(onlyPays, [intent()])).toEqual({ ok: false, reason: "no_leg" });
  });

  it("memilih intent kedua bila yang pertama tidak cocok", () => {
    const small = intent({ offer: side("translate", 500), need: side("summarize", 50), nonce: "small" });
    const good = intent({ nonce: "good" });
    expect(check(ringTerms(), [small, good])).toEqual({ ok: true, intentHash: intentHash(good) });
    expect(check(ringTerms(), [small])).toMatchObject({ ok: false });
  });
});
