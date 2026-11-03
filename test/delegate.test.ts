// AG-029: agents with a delegate order (SD-072, ADR-47 item 4) through the real order book and claim route of the backend (BE-055), in process, with a mock node: a token owner (`owner`)
// hires a delegate (`delegate`) to vote on a DAO according to a public mandate. The vote is a call to the DAO, not an event of the circle, so the delegate claims each transaction with a
// signed notice and the backend checks it through its RPC (here a mock that returns the answer of `tx` for a given hash). The paying side is the SDK: one voucher per proposal, only for
// `VoteApprove` or `VoteReject` on a kind of the mandate, nothing twice, nothing for another DAO, and nothing above the budget.
import { afterEach, describe, expect, it } from "vitest";
import { mandateHash, verifyVoucher, type DelegateMandate, type OrderDocument } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { OrderBook, hashOf, ledgerFor, payProofs } from "../scenario/services.ts";
import { chainVoucher } from "./chain.ts";
import { BACKEND_AVAILABLE, CIRCLE_ID, CONTRACT, acct, startMarket } from "./backend-fixtures.ts";

const credit = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const DAO = "gauge.sputnik-dao.near";
const mandate: DelegateMandate = { circle: CONTRACT, dao: DAO, kinds: ["function_call", "transfer"], rules_hash: hashOf("c") };

describe.skipIf(!BACKEND_AVAILABLE)("AG-029 delegate: paid per vote on the mandate, claimed with a signed notice", () => {
  let market: any;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  /** The mock node: transaction hash -> what the RPC `tx` answers; block hash -> time of the block (ns). */
  const txs = new Map<string, any>();
  const blockNs = (market0: () => any) => BigInt(market0().clock.now + 60_000) * 1_000_000n; // blocks are a minute after the order
  /** The kinds of the proposals on the DAO, as the view `get_proposal` answers them. */
  const proposals = new Map<number, unknown>([[7, { kind: { Transfer: {} } }], [8, { kind: { FunctionCall: {} } }], [9, { kind: "Vote" }], [10, { kind: { Transfer: {} } }], [11, { kind: { Transfer: {} } }], [12, { kind: { Transfer: {} } }]]);
  const callOf = (signer: string, receiver: string, id: number, action: string, method = "act_proposal") => ({
    status: { SuccessValue: "" },
    transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify({ id, action })).toString("base64") } }] },
    transaction_outcome: { block_hash: "block1" },
    receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
  });
  const TX = (n: number): string => `${n}AXdP1c3JTqDyhsVSpfwLnPL1n9FnVZqkbtRMbLAA9c`.slice(0, 44);

  async function start() {
    txs.clear();
    market = await startMarket(["owner", "delegate"], {
      chainView: async (_account: string, method: string, args: { id: number }) => (method === "get_proposal" ? (proposals.get(args.id) ?? null) : null),
      claimRpc: { tx: async (hash: string) => txs.get(hash) ?? null, blockTimestampNs: async () => blockNs(() => market) },
    });
    const actor = (name: string) => ({ account: acct(name), secretKey: market.keys[name].secretKey, publicKey: market.keys[name].publicKey });
    const book = new OrderBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const doc: OrderDocument = {
      circle: CONTRACT, kind: "delegate", buyer: acct("owner"), seller: acct("delegate"), spec_hash: hashOf("a"), sample_hash: null, target: null,
      proof: { method: "act_proposal", amount_per_tx: credit(1) }, mandate_hash: mandateHash(mandate), nonce: "deleg-1",
      milestones: [{ amount: credit(3), due_at: Math.floor(market.clock.now / 1000) + 86_400 }],
    };
    return { book, owner: actor("owner"), delegate: actor("delegate"), doc };
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof BookError ? `${e.status} ${e.code}` : `other: ${String(e)}`;
    }
  };

  it("TC-AG-029-01 the order needs its mandate: without it, or with another one, it is refused; with it, it opens after both signatures", async () => {
    const { book, owner, delegate, doc } = await start();
    expect(await code(book.open(doc, owner, delegate))).toMatch(/order_mandate_required/);
    expect(await code(book.open(doc, owner, delegate, { ...mandate, kinds: ["transfer"] }))).toMatch(/order_bad_mandate/);
    const hash = await book.open(doc, owner, delegate, mandate);
    const view = await book.get(hash);
    expect(view.status).toBe("open");
    expect((view as any).mandate).toEqual({ circle: CONTRACT, dao: DAO, kinds: ["function_call", "transfer"], rules_hash: hashOf("c") });
  });

  it("TC-AG-029-02 the delegate claims its votes and the owner pays one voucher per proposal: the refusals of the backend and of the SDK, and nothing twice", async () => {
    const { book, owner, delegate, doc } = await start();
    const hash = await book.open(doc, owner, delegate, mandate);
    txs.set(TX(1), callOf(acct("delegate"), DAO, 7, "VoteApprove")); // transfer: on the mandate
    txs.set(TX(2), callOf(acct("delegate"), DAO, 8, "VoteReject")); // function_call: on the mandate
    txs.set(TX(3), callOf(acct("delegate"), DAO, 9, "VoteApprove")); // vote: not on the mandate
    txs.set(TX(4), callOf(acct("delegate"), DAO, 10, "Finalize")); // not a vote
    txs.set(TX(5), callOf(acct("delegate"), "other.sputnik-dao.near", 11, "VoteApprove")); // another DAO
    txs.set(TX(6), callOf(acct("owner"), DAO, 12, "VoteApprove")); // not signed by the delegate
    txs.set(TX(7), callOf(acct("delegate"), DAO, 7, "VoteReject")); // the same proposal again
    expect(await code(book.claim(hash, TX(1), delegate))).toBe("no error");
    expect(await code(book.claim(hash, TX(2), delegate))).toBe("no error");
    expect(await code(book.claim(hash, TX(3), delegate))).toMatch(/claim_invalid/);
    for (const [n, reason] of [[3, "kind_not_in_mandate"], [4, "not_a_vote"], [5, "wrong_receiver"], [6, "wrong_signer"], [7, "already_claimed"]] as const) {
      const error = await book.claim(hash, TX(n), n === 6 ? owner : delegate).catch((e) => e);
      expect(error, String(n)).toBeInstanceOf(BookError);
      expect(error.status).toBe(n === 6 ? 403 : 400);
      if (n !== 6) expect(error.message).toContain(reason.replace("kind_not_in_mandate", "jenis proposal di luar mandat").replace("not_a_vote", "hanya VoteApprove").replace("wrong_receiver", "DAO dalam mandat").replace("already_claimed", "sudah diklaim"));
    }
    expect(await code(book.claim(hash, TX(99), delegate))).toMatch(/claim_invalid/); // the node does not know it
    expect(await code(book.claim(hash, TX(1), owner))).toMatch(/403/); // only the seller claims

    // what the owner reads and pays
    const { items } = await book.proofs(hash);
    expect(items.map((p) => [p.proposal_id, p.action, p.proposal_kind, p.receiver])).toEqual([[7, "VoteApprove", "transfer", DAO], [8, "VoteReject", "function_call", DAO]]);
    const ledger = ledgerFor(doc);
    const state = { seq: 0, cumulativeAmount: "0" };
    const paid = payProofs(ledger, 42, state, items, owner, mandate);
    expect(paid.paid).toHaveLength(2);
    expect(paid.refused).toEqual([]);
    for (const v of paid.vouchers) {
      expect(verifyVoucher(v, owner.publicKey)).toBe(true);
      chainVoucher(market, { payer: "owner", payee: "delegate", epoch: 42, seq: v.seq, cumulative: v.cumulativeAmount });
    }
    expect(paid.vouchers.map((v) => v.cumulativeAmount)).toEqual([credit(1), credit(2)]);
    // the agent runs again: a proposal is not paid twice, even with another transaction on it
    const again = payProofs(ledger, 42, paid.state, items, owner, mandate);
    expect(again.paid).toEqual([]);
    expect(again.refused.map((r) => r.reason)).toEqual(["already_paid", "already_paid"]);
    // the SDK refuses on its own what the backend would never list: a claim of another DAO and a finalize
    const forged = [
      { txHash: TX(5), method: "act_proposal", signer: acct("delegate"), receiver: "other.sputnik-dao.near", proposal_id: 11, action: "VoteApprove", proposal_kind: "transfer" },
      { txHash: TX(4), method: "act_proposal", signer: acct("delegate"), receiver: DAO, proposal_id: 10, action: "Finalize", proposal_kind: "transfer" },
    ];
    expect(payProofs(ledgerFor(doc), 42, state, forged, owner, mandate).refused.map((r) => r.reason)).toEqual(["wrong_receiver", "not_a_vote"]);
  });

  it("TC-AG-029-03 a vote cast before the order was made is refused (before_order), and a backend with no RPC for claims answers 503 claim_rpc_unavailable", async () => {
    const { book, owner, delegate, doc } = await start();
    const hash = await book.open(doc, owner, delegate, mandate);
    txs.set(TX(1), callOf(acct("delegate"), DAO, 7, "VoteApprove"));
    // the node says the block is from before the order
    const early = { tx: async (h: string) => txs.get(h) ?? null, blockTimestampNs: async () => BigInt(market.clock.now - 3_600_000) * 1_000_000n };
    await market.srv.close();
    market.db.close();
    market = await startMarket(["owner", "delegate"], { chainView: async () => ({ kind: { Transfer: {} } }), claimRpc: early });
    const owner2 = { account: acct("owner"), secretKey: market.keys.owner.secretKey, publicKey: market.keys.owner.publicKey };
    const delegate2 = { account: acct("delegate"), secretKey: market.keys.delegate.secretKey, publicKey: market.keys.delegate.publicKey };
    const book2 = new OrderBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const hash2 = await book2.open(doc, owner2, delegate2, mandate);
    const error = await book2.claim(hash2, TX(1), delegate2).catch((e) => e);
    expect(error.message).toContain("sebelum pesanan dibuat");
    // and without a claim RPC at all
    await market.srv.close();
    market.db.close();
    market = await startMarket(["owner", "delegate"], {});
    const owner3 = { account: acct("owner"), secretKey: market.keys.owner.secretKey, publicKey: market.keys.owner.publicKey };
    const delegate3 = { account: acct("delegate"), secretKey: market.keys.delegate.secretKey, publicKey: market.keys.delegate.publicKey };
    const book3 = new OrderBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const hash3 = await book3.open(doc, owner3, delegate3, mandate);
    expect(await code(book3.claim(hash3, TX(1), delegate3))).toBe("503 claim_rpc_unavailable");
    void hash;
  });

  it("TC-AG-029-04 the budget of the order stops the payment: three votes of one credit each fill it, the fourth is over_budget", async () => {
    const { book, owner, delegate, doc } = await start();
    const hash = await book.open(doc, owner, delegate, mandate);
    for (const [n, id] of [[1, 7], [2, 10], [3, 11], [4, 12]] as const) {
      txs.set(TX(n), callOf(acct("delegate"), DAO, id, "VoteApprove"));
      expect(await code(book.claim(hash, TX(n), delegate))).toBe("no error");
    }
    const { items } = await book.proofs(hash);
    expect(items).toHaveLength(4);
    const result = payProofs(ledgerFor(doc), 42, { seq: 0, cumulativeAmount: "0" }, items, owner, mandate);
    expect(result.paid).toHaveLength(3);
    expect(result.refused.map((r) => r.reason)).toEqual(["over_budget"]);
    expect(result.spent).toBe(credit(3));
  });
});
