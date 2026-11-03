// Agen yang memesan dan mengerjakan jasa (AG-026, pipeline P6, ADR-45) dengan format SDK (SD-069): pesanan bertanda tangan dua pihak, tonggak dengan kiriman, konfirmasi atau
// sengketa di jendela, hasil per lead, dan bayar per transaksi penyedia (keeper). Hanya paket publik (`@x207/core`) dan HTTP. Buku pesanan tidak membayar apa pun: pembeli
// menandatangani voucher setelah tonggak terkonfirmasi (`milestoneVoucher`) atau per bukti on-chain (`payForProofs`), dan penjual mendaftarkannya.
import { createHash } from "node:crypto";
import {
  OrderLedger, nep413SigningHash, orderHash, serializeOrder, signHash,
  type InvoicePairState, type OnchainProof, type OrderDocument, type Voucher,
} from "@x207/core";
import { BookError, signJsonNotice, type InvoiceActor } from "./invoice-book.ts";

export type OrderState = {
  orderHash: string; status: string; buyer: string; seller: string; needsBond: boolean; targetVerified: boolean | null; signedBy: string[]; budget: string
  milestones: Array<{ index: number; amount: string; dueAt: number; status: string; outcome: string | null; deliverableHash: string | null; autoConfirmed: boolean; disputeReason: string | null }>
}
const H = (c: string): string => c.repeat(64);
export const hashOf = H;

export class OrderBook {
  private readonly base: string;
  private readonly circleId: string;
  readonly contract: string;
  private readonly now: () => number;

  constructor(base: string, circleId: string, contract: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.base = base;
    this.circleId = circleId;
    this.contract = contract;
    this.now = now;
  }
  at(): number {
    return this.now();
  }
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}/x207/circles/${this.circleId}${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new BookError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "");
    return json;
  }

  get(hash: string): Promise<OrderState> {
    return this.call("GET", `/orders/${hash}`);
  }
  /** Pesanan dibuka setelah KEDUA pihak menandatangani: tanda tangan pertama menyimpannya sebagai `proposed`, yang kedua membukanya. */
  async open(doc: OrderDocument, buyer: InvoiceActor, seller: InvoiceActor): Promise<string> {
    // the signature is over serializeOrder(doc) itself: the same bytes the backend hashes
    const sign = (a: InvoiceActor) => ({ account: a.account, signature: signRaw(this.contract, serializeOrder(doc), a) });
    await this.call("POST", "/orders", { order: doc, signatures: [sign(buyer)] });
    await this.call("POST", "/orders", { order: doc, signatures: [sign(seller)] });
    return orderHash(doc);
  }
  milestone(hash: string, index: number, actor: InvoiceActor, action: "delivered" | "confirmed" | "disputed" | "cancelled", o: { deliverable?: string; reason?: string } = {}) {
    const notice = { circle: this.contract, order_hash: hash, milestone: index, actor: actor.account, action, at: this.at(), deliverable_hash: action === "delivered" ? (o.deliverable ?? null) : null, reason: action === "disputed" ? (o.reason ?? null) : null };
    return this.call("POST", `/orders/${hash}/milestones/${index}`, { notice, signature: signJsonNotice(this.contract, notice, actor.secretKey) });
  }
  outcome(hash: string, place: number, actor: InvoiceActor, action: "proposed" | "accepted" | "rejected", o: { result?: string; reason?: string } = {}) {
    const notice = { circle: this.contract, order_hash: hash, milestone: place, actor: actor.account, action, at: this.at(), deliverable_hash: action === "proposed" ? (o.result ?? null) : null, reason: action === "rejected" ? (o.reason ?? null) : null };
    return this.call("POST", `/orders/${hash}/outcomes`, { notice, signature: signJsonNotice(this.contract, notice, actor.secretKey) });
  }
  proofs(hash: string): Promise<{ items: OnchainProof[]; maxProofs: number }> {
    return this.call("GET", `/orders/${hash}/onchain-proofs`);
  }
}

function signRaw(contract: string, json: string, actor: InvoiceActor): string {
  return signHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), contract), actor.secretKey);
}

/** Buku bayar satu pesanan di sisi pembeli: ingat tonggak dan bukti yang sudah dibayar (tinjauan BE-062, F4 dan F5). */
export const ledgerFor = (order: OrderDocument): OrderLedger => new OrderLedger(order);

/** Pembeli membayar tonggak yang sudah terkonfirmasi: voucher dari keadaan pasangan yang sebenarnya, ditandatangani, siap didaftarkan penjual; tonggak yang sama dua kali ditolak buku. */
export function payMilestone(ledger: OrderLedger, index: number, epoch: number, state: InvoicePairState, buyer: InvoiceActor): Voucher {
  return ledger.payMilestone({ index, epoch, state, secretKey: buyer.secretKey });
}

/** Agent pembeli untuk jasa keeper atau solver: satu voucher per bukti yang cocok, tidak lewat anggaran, dan tidak dua kali. */
export function payProofs(ledger: OrderLedger, epoch: number, state: InvoicePairState, proofs: readonly OnchainProof[], buyer: InvoiceActor) {
  return ledger.payProofs({ epoch, state, proofs, secretKey: buyer.secretKey });
}
