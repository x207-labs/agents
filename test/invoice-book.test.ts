// AG-025: agents with invoices and installments against the real invoice book of the backend (BE-051), in process: in-memory database, real routes, members with real voucher
// keys. What the contract and the indexer do is played by `chainVoucher` and `closeEpoch` of the backend tests (the event `voucher_registered` and the obligation row); the full
// run against a contract is UM-086. Skipped when the backend repo is missing (CI of agents stands alone).
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InvoiceError, invoiceHash, type InvoiceDocument } from "@x207/core";
import { InvoiceBook, BookError, type InvoiceActor } from "../scenario/invoice-book.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct, startMarketBook, type MarketBook } from "./market.ts";

const load = (path: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}${path}`).href);
const CREDIT = 1_000_000n;
const credit = (n: number): string => (BigInt(n) * CREDIT).toString();

describe.skipIf(!BACKEND_AVAILABLE)("AG-025 invoice and installments through the invoice book", () => {
  let market: MarketBook | undefined;
  afterEach(async () => {
    await market?.stop();
    market = undefined;
  });

  async function start() {
    market = await startMarketBook(["supplier", "maker", "retailer"]);
    const helpers = await load("test/marketplace/invoice-helpers.ts");
    const actor = (name: string): InvoiceActor => ({ account: acct(name), secretKey: market!.identities[name]!.voucherSecretKey });
    const book = new InvoiceBook(market.url, CIRCLE_ID, CONTRACT);
    const chain = (payer: string, payee: string, epoch: number, seq: number, cumulative: string) => helpers.chainVoucher(market, { payer, payee, epoch, seq, cumulative });
    const close = (epoch: number) => helpers.closeEpoch(market, epoch);
    /** The pair (debtor, creditor) in an epoch as the contract holds it: what the debtor needs to build the catch-up voucher. */
    const pair = (epoch: number, debtor: string, creditor: string) => {
      const row = market!.db.prepare("SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").get(CIRCLE_ID, epoch, acct(debtor), acct(creditor)) as { seq: number | bigint; cumulative_amount: string } | undefined;
      return { seq: Number(row?.seq ?? 0), cumulativeAmount: row?.cumulative_amount ?? "0" };
    };
    const doc = (issuer: string, debtor: string, over: Partial<InvoiceDocument> = {}): InvoiceDocument => ({ id: "INV-2026-001", issuer: acct(issuer), debtor: acct(debtor), amount: credit(90), memo: "components, October batch", ...over });
    return { book, actor, chain, close, pair, doc };
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      // a BookError is the answer of the book; an InvoiceError is the SDK of the agent refusing before it asks the book
      return e instanceof BookError || e instanceof InvoiceError ? e.code : `other: ${String(e)}`;
    }
  };

  it("TC-AG-025-01 an invoice of three installments in three epochs: requested, approved by the debtor with three vouchers signed at once, registered epoch by epoch", async () => {
    const { book, actor, chain, doc } = await start();
    const d = doc("supplier", "maker");
    const requested = await book.request(d, 3, actor("supplier"));
    expect(requested).toMatchObject({ status: "requested", needsBond: false });
    expect(requested.invoiceHash).toBe(invoiceHash(d));
    expect(requested.installments.map((i) => [i.epoch, i.amount, i.status])).toEqual([[43, credit(30), "scheduled"], [44, credit(30), "scheduled"], [45, credit(30), "scheduled"]]);
    expect((await book.approve(requested.invoiceHash, actor("maker"))).status).toBe("approved");
    // the issuer registers the voucher of each installment in its own epoch: seq 1, cumulative of the installment alone
    chain("maker", "supplier", 43, 1, credit(30));
    expect((await book.get(requested.invoiceHash)).installments.map((i) => i.status)).toEqual(["registered", "scheduled", "scheduled"]);
    chain("maker", "supplier", 44, 1, credit(30));
    chain("maker", "supplier", 45, 1, credit(30));
    const done = await book.get(requested.invoiceHash);
    expect(done.status).toBe("registered");
    expect(done.installments.every((i) => i.status === "registered" && !i.shifted)).toBe(true);
    expect((await book.list(acct("maker"), "registered")).items.map((i) => i.invoiceHash)).toEqual([requested.invoiceHash]);
  });

  it("TC-AG-025-02 an invoice that the debtor rejects is not paid: the reason is kept, and it cannot be approved afterwards", async () => {
    const { book, actor, doc } = await start();
    const d = doc("retailer", "supplier", { id: "INV-2026-002", amount: credit(60) });
    const requested = await book.request(d, 1, actor("retailer"));
    const rejected = await book.reject(d, actor("supplier"), "services were not delivered");
    expect(rejected).toMatchObject({ status: "rejected", rejectReason: "services were not delivered" });
    expect(await code(book.approve(requested.invoiceHash, actor("supplier")))).toBe("invoice_bad_state");
    // the issuer cannot reject its own invoice
    const other = doc("retailer", "supplier", { id: "INV-2026-003" });
    await book.request(other, 1, actor("retailer"));
    expect(await code(book.reject(other, actor("retailer"), "oops"))).toBe("invoice_not_party");
  });

  it("TC-AG-025-03 the same invoice twice is refused; the same text with another number is another invoice", async () => {
    const { book, actor, doc } = await start();
    const d = doc("supplier", "maker");
    await book.request(d, 1, actor("supplier"));
    expect(await code(book.request(d, 3, actor("supplier")))).toBe("invoice_duplicate");
    expect(await code(book.request(doc("supplier", "maker", { id: "INV-2026-009" }), 1, actor("supplier")))).toBe("no error");
    expect(await code(book.request(doc("supplier", "maker", { id: "INV-2026-010", amount: "0" }), 1, actor("supplier")))).toBe("invoice_bad_amount");
  });

  it("TC-AG-025-04 an installment above the limit of the debtor (the contract refuses it, so no event) stays scheduled with reason headroom, and the debtor shifts it once after the failure", async () => {
    const { book, actor, close, doc } = await start();
    const requested = await book.request(doc("supplier", "maker"), 3, actor("supplier"));
    await book.approve(requested.invoiceHash, actor("maker"));
    expect(await code(book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" }))).toBe("installment_bad_state"); // nothing failed yet: no voucher in advance
    close(43); // epoch 43: ERR_INSUFFICIENT_CREDIT, no event, the epoch ends
    expect((await book.get(requested.invoiceHash)).installments[0]).toMatchObject({ status: "scheduled", reason: "headroom", shifted: false });
    const shifted = await book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" });
    expect(shifted.installments[0]).toMatchObject({ status: "shifted", epoch: 43, voucherEpoch: 44, shifted: true });
    expect(await code(book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" }))).toBe("installment_already_shifted");
  });

  it("TC-AG-025-05 a catch-up voucher is built on the state of the pair in the next epoch after the installment of that epoch got in; a stale state is refused", async () => {
    const { book, actor, chain, close, pair, doc } = await start();
    const requested = await book.request(doc("supplier", "maker"), 3, actor("supplier"));
    await book.approve(requested.invoiceHash, actor("maker"));
    close(43);
    chain("maker", "supplier", 44, 1, credit(30)); // installment 2 gets in first
    expect(await code(book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" }))).toBe("installment_voucher_mismatch");
    const shifted = await book.catchUp(requested.invoiceHash, 1, actor("maker"), pair(44, "maker", "supplier"));
    expect(shifted.installments[0]).toMatchObject({ status: "shifted", epoch: 43, voucherEpoch: 44, shifted: true });
    // the issuer registers the catch-up voucher: seq 2, cumulative of both installments
    chain("maker", "supplier", 44, 2, credit(60));
    chain("maker", "supplier", 45, 1, credit(30));
    const done = await book.get(requested.invoiceHash);
    expect(done.installments.map((i) => i.status)).toEqual(["registered", "registered", "registered"]);
    expect(done.status).toBe("registered");
  });

  it("TC-AG-025-06 an installment that fails again after the shift is missed, with no second catch-up", async () => {
    const { book, actor, close, doc } = await start();
    const requested = await book.request(doc("supplier", "maker", { id: "INV-2026-004", amount: credit(30) }), 1, actor("supplier"));
    await book.approve(requested.invoiceHash, actor("maker"));
    close(43);
    await book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" });
    close(44); // the voucher of the shift never got in either
    const view = await book.get(requested.invoiceHash);
    expect(view.installments[0]).toMatchObject({ status: "missed", reason: "headroom" });
    expect(view.status).toBe("missed");
    expect(["installment_already_shifted", "installment_bad_state"]).toContain(await code(book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" })));
  });

  it("TC-AG-025-07 a debtor that registers a voucher with a higher seq first blocks the installment: missed, blocked_by_debtor, and no catch-up is allowed", async () => {
    const { book, actor, chain, close, doc } = await start();
    const requested = await book.request(doc("supplier", "maker", { id: "INV-2026-005", amount: credit(30) }), 1, actor("supplier"));
    await book.approve(requested.invoiceHash, actor("maker"));
    chain("maker", "supplier", 43, 3, credit(1)); // the contract allows gaps in seq: seq 1 can no longer be registered
    close(43);
    const view = await book.get(requested.invoiceHash);
    expect(view.installments[0]).toMatchObject({ status: "missed", reason: "blocked_by_debtor" });
    expect(view.status).toBe("missed");
    expect(await code(book.catchUp(requested.invoiceHash, 1, actor("maker"), { seq: 0, cumulativeAmount: "0" }))).not.toBe("no error");
  });

  // Main C is fixing this: an installment paid by a voucher with seq 2 or more whose cumulative already holds it counts as registered (spec 5e). `it.fails` until the fix is in the
  // backend; when it turns red the fix is there and this becomes a plain `it`.
  it.fails("TC-AG-025-08 an installment paid through an ordinary voucher of seq 2 whose cumulative holds it is registered", async () => {
    const { book, actor, chain, doc } = await start();
    const requested = await book.request(doc("supplier", "maker", { id: "INV-2026-006", amount: credit(30) }), 1, actor("supplier"));
    await book.approve(requested.invoiceHash, actor("maker"));
    chain("maker", "supplier", 43, 1, credit(5)); // an ordinary payment of the debtor first
    chain("maker", "supplier", 43, 2, credit(35)); // then a voucher of seq 2 that holds the installment (5 + 30)
    expect((await book.get(requested.invoiceHash)).installments[0].status).toBe("registered");
  });
});
