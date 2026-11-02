import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, verifyVoucher } from "@x207/core";
import { buildInvoiceVouchers, credit, edgesOf, formatNetting, invoiceHash, invoiceResource, latestPerPair, netInvoices, sampleInvoices, type Invoice } from "../scenario/invoices.ts";

const B = { supplier: "supplier.x207-circle.near", maker: "maker.x207-circle.near", retailer: "retailer.x207-circle.near" };

describe("AG-021 invoice menjadi voucher dan netting", () => {
  const invoices = sampleInvoices(B);

  it("hash invoice deterministik dan peka terhadap isi; resource memuat hash saja", () => {
    const h = invoiceHash(invoices[0]!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceHash({ ...invoices[0]! })).toBe(h);
    expect(invoiceHash({ ...invoices[0]!, amount: credit(101) })).not.toBe(h);
    expect(invoiceHash({ ...invoices[0]!, memo: "other" })).not.toBe(h);
    expect(invoiceResource(invoices[0]!)).toBe(`invoice:${h}`);
    expect(invoiceResource(invoices[0]!)).not.toContain("components");
  });

  it("satu voucher kumulatif per invoice, ditandatangani debitur, resource = hash invoice", () => {
    const keys = Object.fromEntries(Object.values(B).map((a) => [a, generateVoucherKeypair()]));
    const vouchers = buildInvoiceVouchers({ circle: "x207-circle.near", epoch: 7, invoices, secretKeys: Object.fromEntries(Object.entries(keys).map(([a, k]) => [a, k.secretKey])) });
    expect(vouchers).toHaveLength(3);
    for (const v of vouchers) {
      expect(v.voucher).toMatchObject({ payer: v.invoice.debtor, payee: v.invoice.issuer, epoch: 7, seq: 1, cumulativeAmount: v.invoice.amount, unit: "credit", resource: `invoice:${v.hash}` });
      expect(verifyVoucher({ ...v.voucher, signature: v.signature }, keys[v.invoice.debtor]!.publicKey)).toBe(true);
    }
  });

  it("invoice kedua untuk pasangan yang sama menaikkan seq dan cumulative; yang didaftarkan voucher terakhir", () => {
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

  it("tanpa kunci debitur, gagal", () => {
    expect(() => buildInvoiceVouchers({ circle: "c", epoch: 1, invoices, secretKeys: {} })).toThrow(/kunci voucher/);
  });

  it("netting cincin 100/60/80: dihapus 60 per edge (180), sisa 60, posisi bersih tetap", () => {
    const n = netInvoices(invoices);
    expect(n.before).toBe(240_000_000n);
    expect(n.cleared).toBe(180_000_000n);
    expect(n.after).toBe(60_000_000n);
    expect(n.before - n.cleared).toBe(n.after);
    expect(n.settlement).toBe(40_000_000n);
    expect(n.residual.map((e) => `${e.debtor.split(".")[0]}>${e.creditor.split(".")[0]}:${e.amount / 1_000_000n}`).sort()).toEqual(["maker>supplier:40", "retailer>maker:20"]);
    // piutang − utang: supplier +100−60 = +40, maker −100+80 = −20, retailer +60−80 = −20
    expect(n.net).toEqual({ [B.maker]: -20_000_000n, [B.supplier]: 40_000_000n, [B.retailer]: -20_000_000n });
    expect(Object.values(n.net).reduce((a, b) => a + b, 0n)).toBe(0n);
    // posisi bersih dari sisa edge sama dengan dari invoice asal
    const fromResidual: Record<string, bigint> = {};
    for (const e of n.residual) {
      fromResidual[e.debtor] = (fromResidual[e.debtor] ?? 0n) - e.amount;
      fromResidual[e.creditor] = (fromResidual[e.creditor] ?? 0n) + e.amount;
    }
    expect(fromResidual).toEqual(n.net);
  });

  it("tanpa siklus tidak ada yang dihapus", () => {
    const chain = invoices.slice(0, 2);
    const n = netInvoices(chain);
    expect(n.cleared).toBe(0n);
    expect(n.after).toBe(n.before);
  });

  it("laporan mencetak total sebelum dan sesudah", () => {
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
