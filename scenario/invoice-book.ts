// Agen yang memakai buku invoice backend (AG-025, pipeline P8, ADR-44) dengan format SDK (SD-065): `x207:invoice:<hash>`, notice bertanda tangan, voucher cicilan seq 1 pasangan
// di epochnya, dan voucher susulan yang ditandatangani setelah gagal. Kode ini hanya memakai paket publik (`@x207/core`) dan HTTP; yang dilakukan kontrak (mendaftarkan voucher)
// bukan urusan agen ini: penagih atau siapa pun mendaftarkan voucher, buku hanya membaca hasilnya.
import { createHash } from "node:crypto";
import {
  catchUpVoucher, installmentVoucher, invoiceHash, nep413SigningHash, planInstallments, signHash, signVoucher,
  type InvoiceDocument, type InvoicePairState, type UnsignedVoucher, type VoucherSecretKey,
} from "@x207/core";

export type InvoiceActor = { account: string; secretKey: VoucherSecretKey };
export type InstallmentState = {
  index: number; epoch: number; amount: string; status: "scheduled" | "registered" | "shifted" | "missed"; reason: "headroom" | "blocked_by_debtor" | null; voucherEpoch: number | null; shifted: boolean;
  /** The voucher the issuer registers, signed by the debtor (the catch-up voucher after a shift); `null` before the debtor approved (BE-051). */
  voucher: UnsignedVoucher | null; signature: string | null;
};
export type InvoiceState = {
  invoiceHash: string; document: InvoiceDocument; issuer: string; debtor: string; status: "requested" | "approved" | "registered" | "rejected" | "expired" | "missed"
  needsBond: boolean; rejectReason: string | null; installments: InstallmentState[];
};
export class BookError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.name = "BookError";
    this.status = status;
    this.code = code;
  }
}

/** Tanda tangan notice JSON apa pun: NEP-413 atas `sha256(json)` dengan penerima akun kontrak (skema yang sama untuk semua notice buku). */
export function signJsonNotice(contract: string, notice: object, secretKey: VoucherSecretKey): string {
  const json = JSON.stringify(notice);
  return signHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), contract), secretKey);
}

/** Notice invoice: JSON kanonik `circle, invoice_hash, actor, action, at, reason`, ditandatangani seperti notice penyerahan (NEP-413 atas `sha256(json)`). */
export function signedNotice(contract: string, doc: InvoiceDocument, actor: InvoiceActor, action: "requested" | "rejected", at: number, reason: string | null = null) {
  const notice = { circle: contract, invoice_hash: invoiceHash(doc), actor: actor.account, action, at, reason };
  const json = JSON.stringify(notice);
  const hash = nep413SigningHash(json, createHash("sha256").update(json).digest(), contract);
  return { notice, signature: signHash(hash, actor.secretKey) };
}

export class InvoiceBook {
  private readonly base: string;
  private readonly circleId: string;
  private readonly contract: string;
  private readonly now: () => number;

  constructor(base: string, circleId: string, contract: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.base = base;
    this.circleId = circleId;
    this.contract = contract;
    this.now = now;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}/x207/circles/${this.circleId}${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new BookError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "");
    return json;
  }

  /** Penagih mengajukan invoice dengan `installments` cicilan. */
  async request(doc: InvoiceDocument, installments: number, issuer: InvoiceActor): Promise<InvoiceState> {
    return this.call("POST", "/invoices", { document: doc, installments, ...signedNotice(this.contract, doc, issuer, "requested", this.now()) });
  }
  get(hash: string): Promise<InvoiceState> {
    return this.call("GET", `/invoices/${hash}`);
  }
  list(party: string, status?: string): Promise<{ items: InvoiceState[] }> {
    return this.call("GET", `/invoices?party=${encodeURIComponent(party)}${status ? `&status=${status}` : ""}`);
  }

  /** Debtor menyetujui: memeriksa hash dan jadwal terhadap rencana SDK, lalu menandatangani semua voucher cicilan sekaligus (seq 1 di epochnya). */
  async approve(hash: string, debtor: InvoiceActor): Promise<InvoiceState> {
    const view = await this.get(hash);
    if (invoiceHash(view.document) !== view.invoiceHash) throw new Error("hash invoice tidak cocok dengan dokumennya: tidak ditandatangani");
    const first = view.installments[0];
    if (!first) throw new Error("invoice tanpa jadwal cicilan");
    const plan = planInstallments({ circle: this.contract, doc: view.document, firstEpoch: first.epoch, count: view.installments.length });
    const same = plan.installments.every((p, k) => view.installments[k]?.epoch === p.epoch && view.installments[k]?.amount === p.amount);
    if (!same) throw new Error("jadwal dari buku tidak sama dengan rencana SDK: tidak ditandatangani");
    const vouchers = plan.installments.map((p) => {
      const voucher = installmentVoucher(plan, p.index);
      return { voucher, signature: signVoucher(voucher, debtor.secretKey).signature };
    });
    return this.call("POST", `/invoices/${hash}/approve`, { vouchers });
  }
  /** Debtor menolak dengan alasan. */
  async reject(doc: InvoiceDocument, debtor: InvoiceActor, reason: string): Promise<InvoiceState> {
    return this.call("POST", `/invoices/${invoiceHash(doc)}/reject`, signedNotice(this.contract, doc, debtor, "rejected", this.now(), reason));
  }
  /** Voucher susulan: ditandatangani HANYA setelah cicilan gagal, di atas keadaan pasangan di epoch tujuan. Digeser sekali. */
  async catchUp(hash: string, index: number, debtor: InvoiceActor, stateInNextEpoch: InvoicePairState): Promise<InvoiceState> {
    const view = await this.get(hash);
    const item = view.installments.find((i) => i.index === index);
    const plan = planInstallments({ circle: this.contract, doc: view.document, firstEpoch: view.installments[0]!.epoch, count: view.installments.length });
    const voucher: UnsignedVoucher = catchUpVoucher(plan, index, stateInNextEpoch, item?.shifted ?? false);
    return this.call("POST", `/invoices/${hash}/installments/${index}/catch-up`, { voucher, signature: signVoucher(voucher, debtor.secretKey).signature });
  }
}
