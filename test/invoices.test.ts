import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, verifyVoucher } from "@x207/core";
import { buildInvoiceVouchers, credit, edgesOf, formatNetting, invoiceHash, invoiceResource, latestPerPair, netInvoices, sampleInvoices, type Invoice } from "../scenario/invoices.ts";

const B = { supplier: "supplier.x207-circle.near", maker: "maker.x207-circle.near", retailer: "retailer.x207-circle.near" };

describe("AG-021 invoices become vouchers and netting", () => {
  const invoices = sampleInvoices(B);

  it("the invoice hash is deterministic and sensitive to content; the resource holds the hash only", () => {
    const h = invoiceHash(invoices[0]!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceHash({ ...invoices[0]! })).toBe(h);
    expect(invoiceHash({ ...invoices[0]!, amount: credit(101) })).not.toBe(h);
    expect(invoiceHash({ ...invoices[0]!, memo: "other" })).not.toBe(h);
    expect(invoiceResource(invoices[0]!)).toBe(`x207:invoice:${h}`);
    expect(invoiceResource(invoices[0]!)).not.toContain("components");
  });

  it("one cumulative voucher per invoice, signed by the debtor, resource = invoice hash", () => {
    const keys = Object.fromEntries(Object.values(B).map((a) => [a, generateVoucherKeypair()]));
    const vouchers = buildInvoiceVouchers({ circle: "x207-circle.near", epoch: 7, invoices, secretKeys: Object.fromEntries(Object.entries(keys).map(([a, k]) => [a, k.secretKey])) });
    expect(vouchers).toHaveLength(3);
    for (const v of vouchers) {
      expect(v.voucher).toMatchObject({ payer: v.invoice.debtor, payee: v.invoice.issuer, epoch: 7, seq: 1, cumulativeAmount: v.invoice.amount, unit: "credit", resource: `x207:invoice:${v.hash}` });
      expect(verifyVoucher({ ...v.voucher, signature: v.signature }, keys[v.invoice.debtor]!.publicKey)).toBe(true);
    }
  });

  it("a second invoice for the same pair raises seq and cumulative; the last voucher is the one registered", () => {
    const extra: Invoice = { id: "INV-2026-004", issuer: B.supplier, debtor: B.maker, amount: credit(25), memo: "spare parts" };
    const keys = { [B.maker]: generateVoucherKeypair(), [B.supplier]: generateVoucherKeypair(), [B.retailer]: generateVoucherKeypair() };
    const all = buildInvoiceVouchers({
      circle: "x207-circle.near", epoch: 7, invoices: [...invoices, extra],
      secretKeys: Object.fromEntries(Object.entries(keys).map(([a, k]) => [a, k.secretKey])),
    });
    const second = all[3]!;
    expect(second.voucher).toMatchObject({ seq: 2, cumulativeAmount: credit(125) });
    const latest = latestPerPair(all);
    expect(latest).toHaveLength(3);
    expect(latest.find((v) => v.invoice.debtor === B.maker)).toBe(second);
    expect(edgesOf([...invoices, extra]).find((e) => e.debtor === B.maker)!.amount).toBe(125_000_000n);
  });

  it("without a debtor key, fails", () => {
    expect(() => buildInvoiceVouchers({ circle: "c", epoch: 1, invoices, secretKeys: {} })).toThrow(/no voucher key/);
  });

  it("ring netting 100/60/80: 60 removed per edge (180), 60 left, net position unchanged", () => {
    const n = netInvoices(invoices);
    expect(n.before).toBe(240_000_000n);
    expect(n.cleared).toBe(180_000_000n);
    expect(n.after).toBe(60_000_000n);
    expect(n.before - n.cleared).toBe(n.after);
    expect(n.settlement).toBe(40_000_000n);
    expect(n.residual.map((e) => `${e.debtor.split(".")[0]}>${e.creditor.split(".")[0]}:${e.amount / 1_000_000n}`).sort()).toEqual(["maker>supplier:40", "retailer>maker:20"]);
    // receivable − debt: supplier +100−60 = +40, maker −100+80 = −20, retailer +60−80 = −20
    expect(n.net).toEqual({ [B.maker]: -20_000_000n, [B.supplier]: 40_000_000n, [B.retailer]: -20_000_000n });
    expect(Object.values(n.net).reduce((a, b) => a + b, 0n)).toBe(0n);
    // net position from the remaining edges equals that from the source invoices
    const fromResidual: Record<string, bigint> = {};
    for (const e of n.residual) {
      fromResidual[e.debtor] = (fromResidual[e.debtor] ?? 0n) - e.amount;
      fromResidual[e.creditor] = (fromResidual[e.creditor] ?? 0n) + e.amount;
    }
    expect(fromResidual).toEqual(n.net);
  });

  it("without a cycle nothing is removed", () => {
    const chain = invoices.slice(0, 2);
    const n = netInvoices(chain);
    expect(n.cleared).toBe(0n);
    expect(n.after).toBe(n.before);
  });

  it("the report prints the total before and after", () => {
    expect(formatNetting(netInvoices(invoices))).toEqual([
      "invoice total before netting: 240 credit",
      "cleared by cycle netting:    180 credit",
      "invoice total after netting:  60 credit (residual edges)",
      expect.stringContaining("residual"),
      expect.stringContaining("residual"),
      "net cash settled through F4:  40 credit",
    ]);
  });
});
