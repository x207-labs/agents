// Agent that uses the backend invoice book (AG-025, pipeline P8, ADR-44) in the SDK format (SD-065): `x207:invoice:<hash>`, signed notice, installment voucher seq 1 of the pair
// in its epoch, and a follow-up voucher signed after a failure. This code only uses the public package (`@x207/core`) and HTTP; what the contract does (registering the voucher)
// is not this agent's concern: the biller or anyone registers the voucher, the book only reads the result.
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

/** Signature of any JSON notice: NEP-413 over `sha256(json)` with the contract account as recipient (the same scheme for all book notices). */
export function signJsonNotice(contract: string, notice: object, secretKey: VoucherSecretKey): string {
  const json = JSON.stringify(notice);
  return signHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), contract), secretKey);
}

/** Invoice notice: canonical JSON `circle, invoice_hash, actor, action, at, reason`, signed like the handover notice (NEP-413 over `sha256(json)`). */
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

  /** The biller submits an invoice with `installments` installments. */
  async request(doc: InvoiceDocument, installments: number, issuer: InvoiceActor): Promise<InvoiceState> {
    return this.call("POST", "/invoices", { document: doc, installments, ...signedNotice(this.contract, doc, issuer, "requested", this.now()) });
  }
  get(hash: string): Promise<InvoiceState> {
    return this.call("GET", `/invoices/${hash}`);
  }
  list(party: string, status?: string): Promise<{ items: InvoiceState[] }> {
    return this.call("GET", `/invoices?party=${encodeURIComponent(party)}${status ? `&status=${status}` : ""}`);
  }

  /** The debtor approves: checks the hash and schedule against the SDK plan, then signs all installment vouchers at once (seq 1 in its epoch). */
  async approve(hash: string, debtor: InvoiceActor, limits: { maxPerCall?: string; maxPerEpoch?: string } = {}): Promise<InvoiceState> {
    const view = await this.get(hash);
    if (invoiceHash(view.document) !== view.invoiceHash) throw new Error("invoice hash does not match its document: not signed");
    const first = view.installments[0];
    if (!first) throw new Error("invoice without an installment schedule");
    const plan = planInstallments({ circle: this.contract, doc: view.document, firstEpoch: first.epoch, count: view.installments.length });
    const same = plan.installments.every((p, k) => view.installments[k]?.epoch === p.epoch && view.installments[k]?.amount === p.amount);
    if (!same) throw new Error("the schedule from the book differs from the SDK plan: not signed");
    // A-AG-10: the owner limits also hold for an invoice; each installment is one voucher in its own epoch
    for (const p of plan.installments) {
      if (limits.maxPerCall !== undefined && BigInt(p.amount) > BigInt(limits.maxPerCall)) throw new Error(`installment ${p.index} of ${p.amount} is above the owner limit per call ${limits.maxPerCall}: not signed`);
      if (limits.maxPerEpoch !== undefined && BigInt(p.amount) > BigInt(limits.maxPerEpoch)) throw new Error(`installment ${p.index} of ${p.amount} is above the owner limit per epoch ${limits.maxPerEpoch}: not signed`);
    }
    const vouchers = plan.installments.map((p) => {
      const voucher = installmentVoucher(plan, p.index);
      return { voucher, signature: signVoucher(voucher, debtor.secretKey).signature };
    });
    return this.call("POST", `/invoices/${hash}/approve`, { vouchers });
  }
  /** The debtor rejects with a reason. */
  async reject(doc: InvoiceDocument, debtor: InvoiceActor, reason: string): Promise<InvoiceState> {
    return this.call("POST", `/invoices/${invoiceHash(doc)}/reject`, signedNotice(this.contract, doc, debtor, "rejected", this.now(), reason));
  }
  /** Follow-up voucher: signed ONLY after an installment fails, on top of the pair state in the target epoch. Shifted once. */
  async catchUp(hash: string, index: number, debtor: InvoiceActor, stateInNextEpoch: InvoicePairState): Promise<InvoiceState> {
    const view = await this.get(hash);
    const item = view.installments.find((i) => i.index === index);
    const plan = planInstallments({ circle: this.contract, doc: view.document, firstEpoch: view.installments[0]!.epoch, count: view.installments.length });
    const voucher: UnsignedVoucher = catchUpVoucher(plan, index, stateInNextEpoch, item?.shifted ?? false);
    return this.call("POST", `/invoices/${hash}/installments/${index}/catch-up`, { voucher, signature: signVoucher(voucher, debtor.secretKey).signature });
  }
}
