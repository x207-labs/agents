// AG-026: agents that order and do work (SD-069, ADR-45) through the real order book of the backend (BE-054, BE-055), in process. A research agent and an audit agent order a service
// of two milestones from each other, one milestone is disputed and not paid; a keeper agent is paid per transaction that shows on the chain; a referral is paid per conversion the
// buyer accepts. The paying side is the SDK: the buyer signs the voucher of a confirmed milestone (`milestoneVoucher`) or of a proof (`payForProofs`); what the contract and the indexer
// do (register the voucher, store the event) is played by `chainVoucher` of the backend tests.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyVoucher, type OrderDocument } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { OrderBook, hashOf, ledgerFor, payMilestone, payProofs } from "../scenario/services.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct } from "./market.ts";

const load = (path: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}${path}`).href);
const CREDIT = 1_000_000n;
const credit = (n: number): string => (BigInt(n) * CREDIT).toString();

describe.skipIf(!BACKEND_AVAILABLE)("AG-026 services: milestones, a dispute, a keeper per transaction, a referral per conversion", () => {
  let market: any;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  let seqs: Record<string, number> = {};

  async function start() {
    seqs = {};
    const { startMarket, openEpoch } = await load("test/marketplace/helpers.ts");
    const helpers = await load("test/marketplace/invoice-helpers.ts");
    market = await startMarket(["research", "audit", "keeper", "referrer"]);
    openEpoch(market, 42);
    const actor = (name: string) => ({ account: acct(name), secretKey: market.keys[name].secretKey, publicKey: market.keys[name].publicKey });
    const book = new OrderBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const due = (days: number) => Math.floor(market.clock.now / 1000) + days * 86_400;
    /** The pair as the contract holds it in epoch 42: what the buyer builds the next voucher on. */
    const pair = (buyer: string, seller: string) => {
      const row = market.db.prepare("SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = 42 AND debtor = ? AND creditor = ?").get(CIRCLE_ID, acct(buyer), acct(seller)) as { seq: number | bigint; cumulative_amount: string } | undefined;
      return { seq: Number(row?.seq ?? 0), cumulativeAmount: String(row?.cumulative_amount ?? "0") };
    };
    /** The seller registers the voucher of the buyer: the event and the obligation row. */
    const register = (v: { payer: string; payee: string; seq: number; cumulativeAmount: string }) =>
      helpers.chainVoucher(market, { payer: v.payer.split(".")[0], payee: v.payee.split(".")[0], epoch: 42, seq: v.seq, cumulative: v.cumulativeAmount });
    let n = 0;
    /** What the indexer stores for an event, with the caller of the transaction. */
    const event = (o: { event: string; signer: string; tx: string; data?: object }) => {
      n += 1;
      market.db
        .prepare(`INSERT INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, tx_hash, signer_id, method_name, contract_id, standard, version, event, data_json, handled)
                  VALUES (?, 0, ?, 'h', ?, ?, ?, NULL, ?, 'x207', '0.0.1', ?, ?, 1)`)
        .run(`ag${n}`, 5000 + n, BigInt(market.clock.now + n * 1000) * 1_000_000n, o.tx, acct(o.signer), CONTRACT, o.event, JSON.stringify(o.data ?? { epoch: 40 + n }));
    };
    const doc = (buyer: string, seller: string, over: Partial<OrderDocument>): OrderDocument => ({
      circle: CONTRACT, kind: "research", buyer: acct(buyer), seller: acct(seller), spec_hash: hashOf("a"), sample_hash: null, target: null, proof: null, nonce: "n1",
      milestones: [{ amount: credit(10), due_at: due(1) }, { amount: credit(20), due_at: due(2) }], ...over,
    });
    return { book, actor, due, pair, register, event, doc };
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof BookError ? e.code : `other: ${String(e)}`;
    }
  };

  it("TC-AG-026-01 two agents order a service of two milestones from each other: confirmed milestones are paid, the disputed one is not, and an order is open only after both signed", async () => {
    const { book, actor, pair, register, doc } = await start();
    const [research, audit] = [actor("research"), actor("audit")];
    const o1 = doc("research", "audit", { kind: "audit", nonce: "audit-1" }); // research buys an audit (the book opens it after both signed)
    const o2 = doc("audit", "research", { kind: "research", nonce: "research-1" }); // audit buys research
    const h1 = await book.open(o1, research, audit);
    const h2 = await book.open(o2, audit, research);
    expect((await book.get(h1)).status).toBe("open");

    // order 1: milestone 1 delivered and confirmed, milestone 2 delivered and disputed
    await book.milestone(h1, 1, audit, "delivered", { deliverable: hashOf("1") });
    expect((await book.milestone(h1, 1, research, "confirmed")).milestones[0].status).toBe("confirmed");
    const l1 = ledgerFor(o1);
    const l2 = ledgerFor(o2);
    const pay1 = payMilestone(l1, 1, 42, pair("research", "audit"), research);
    expect(verifyVoucher(pay1, research.publicKey)).toBe(true);
    register(pay1);
    expect((await book.get(h1)).milestones[0].status).toBe("paid");
    await book.milestone(h1, 2, audit, "delivered", { deliverable: hashOf("2") });
    expect((await book.milestone(h1, 2, research, "disputed", { reason: "not_as_described" })).milestones[1]).toMatchObject({ status: "disputed", disputeReason: "not_as_described" });
    // order 2: both confirmed and paid, the second voucher on top of the first
    for (const i of [1, 2]) {
      await book.milestone(h2, i, research, "delivered", { deliverable: hashOf(String(2 + i)) });
      await book.milestone(h2, i, audit, "confirmed");
      register(payMilestone(l2, i, 42, pair("audit", "research"), audit));
    }
    expect((await book.get(h2)).milestones.map((m) => m.status)).toEqual(["paid", "paid"]);
    // what moved: research owes audit 10 (milestone 1 of order 1), audit owes research 30
    expect(pair("research", "audit").cumulativeAmount).toBe(credit(10));
    expect(pair("audit", "research").cumulativeAmount).toBe(credit(30));
    // the disputed milestone stays unpaid and cannot be confirmed afterwards
    expect(await code(book.milestone(h1, 2, research, "confirmed"))).not.toBe("no error");
  });

  it("TC-AG-026-02 a keeper agent is paid per transaction that shows on the chain: the buyer signs one voucher per proof, nothing for another account, nothing twice, nothing above the budget", async () => {
    const { book, actor, pair, register, event, doc } = await start();
    const [buyer, keeper] = [actor("research"), actor("keeper")];
    const order = doc("research", "keeper", {
      kind: "keeper", nonce: "keep-1", proof: { method: "close_epoch", amount_per_tx: credit(1) }, milestones: [{ amount: credit(3), due_at: Math.floor(market.clock.now / 1000) + 86_400 }],
    });
    const hash = await book.open(order, buyer, keeper);
    event({ event: "epoch_cutoff", signer: "keeper", tx: "tx-1" });
    event({ event: "epoch_cutoff", signer: "keeper", tx: "tx-2" });
    event({ event: "epoch_cutoff", signer: "audit", tx: "tx-other" }); // another account
    event({ event: "epoch_cutoff", signer: "keeper", tx: "tx-3" });
    event({ event: "epoch_cutoff", signer: "keeper", tx: "tx-4" }); // above the budget of 3
    const { items } = await book.proofs(hash);
    expect(items.map((p) => p.txHash).sort()).toEqual(["tx-1", "tx-2", "tx-3", "tx-4"]);
    const ledger = ledgerFor(order);
    const first = payProofs(ledger, 42, pair("research", "keeper"), items, buyer);
    expect(first.paid).toHaveLength(3);
    expect(first.refused).toEqual([{ txHash: expect.any(String), reason: "over_budget" }]);
    for (const v of first.vouchers) {
      expect(verifyVoucher(v, buyer.publicKey)).toBe(true);
      register(v);
    }
    expect(pair("research", "keeper").cumulativeAmount).toBe(credit(3));
    // the agent runs again: what it paid is not paid again
    const again = payProofs(ledger, 42, pair("research", "keeper"), items, buyer);
    expect(again.paid).toEqual([]);
    expect(again.refused.every((r) => r.reason === "already_paid" || r.reason === "over_budget")).toBe(true);
  });

  it("TC-AG-026-03 a referral is paid per conversion: the seller proposes the result of each place, the buyer accepts one and rejects the other, and a silent buyer pays nothing", async () => {
    const { book, actor, pair, register, doc } = await start();
    const [buyer, referrer] = [actor("research"), actor("referrer")];
    const order = doc("research", "referrer", { kind: "lead", nonce: "lead-1", milestones: [{ amount: credit(5), due_at: Math.floor(market.clock.now / 1000) + 86_400 }, { amount: credit(5), due_at: Math.floor(market.clock.now / 1000) + 2 * 86_400 }] });
    const hash = await book.open(order, buyer, referrer);
    await book.outcome(hash, 1, referrer, "proposed", { result: hashOf("c") });
    await book.outcome(hash, 2, referrer, "proposed", { result: hashOf("d") });
    expect(await code(book.outcome(hash, 2, referrer, "proposed", { result: hashOf("d") }))).not.toBe("no error"); // the same result cannot fill two places, nor one place twice
    const accepted = await book.outcome(hash, 1, buyer, "accepted", { result: hashOf("c") });
    expect(accepted.milestones[0]).toMatchObject({ status: "confirmed", outcome: "accepted" });
    const rejected = await book.outcome(hash, 2, buyer, "rejected", { reason: "not_a_customer" });
    expect(rejected.milestones[1]).toMatchObject({ status: "disputed", outcome: "rejected" });
    register(payMilestone(ledgerFor(order), 1, 42, pair("research", "referrer"), buyer));
    const after = await book.get(hash);
    expect(after.milestones.map((m) => m.status)).toEqual(["paid", "disputed"]);
    expect(pair("research", "referrer").cumulativeAmount).toBe(credit(5)); // the rejected conversion is not paid
    // the clock runs far beyond any window: there is no automatic confirmation for leads
    market.clock.now += 30 * 86_400 * 1000;
    expect((await book.get(hash)).milestones[1].status).toBe("disputed");
  });
});
