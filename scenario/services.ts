// Agent that orders and performs services (AG-026, pipeline P6, ADR-45) in the SDK format (SD-069): an order signed by both parties, milestones with deliveries, confirmation or
// dispute in a window, results per lead, and pay per provider transaction (keeper). Only the public package (`@x207/core`) and HTTP. The order book does not pay anything: the buyer
// signs a voucher after a milestone is confirmed (`milestoneVoucher`) or per on-chain proof (`payForProofs`), and the seller registers it.
import { createHash } from "node:crypto";
import {
  OrderLedger, nep413SigningHash, orderClaimNotice, orderHash, serializeOrder, signHash,
  type DelegateMandate, type InvoicePairState, type OnchainProof, type OrderDocument, type Voucher,
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
  /** The order opens after BOTH parties sign: the first signature stores it as `proposed`, the second opens it. */
  async open(doc: OrderDocument, buyer: InvoiceActor, seller: InvoiceActor, mandate?: DelegateMandate): Promise<string> {
    // the signature is over serializeOrder(doc) itself: the same bytes the backend hashes; a delegate order also carries its mandate (SD-072)
    const sign = (a: InvoiceActor) => ({ account: a.account, signature: signRaw(this.contract, serializeOrder(doc), a) });
    const extra = mandate ? { mandate } : {};
    await this.call("POST", "/orders", { order: doc, signatures: [sign(buyer)], ...extra });
    await this.call("POST", "/orders", { order: doc, signatures: [sign(seller)], ...extra });
    return orderHash(doc);
  }
  /** The delegate claims one transaction of its vote (SD-072, BE-055): a notice signed like the other notices; the backend checks the transaction through its RPC. */
  claim(hash: string, txHash: string, seller: InvoiceActor) {
    const notice = orderClaimNotice({ circle: this.contract, orderHash: hash, actor: seller.account, at: this.at(), txHash });
    return this.call("POST", `/orders/${hash}/claims`, { tx_hash: txHash, notice, signature: signJsonNotice(this.contract, notice, seller.secretKey) });
  }
  milestone(hash: string, index: number, actor: InvoiceActor, action: "delivered" | "confirmed" | "disputed" | "cancelled", o: { deliverable?: string; reason?: string } = {}) {
    const notice = { circle: this.contract, order_hash: hash, milestone: index, actor: actor.account, action, at: this.at(), deliverable_hash: action === "delivered" ? (o.deliverable ?? null) : null, reason: action === "disputed" ? (o.reason ?? null) : null };
    return this.call("POST", `/orders/${hash}/milestones/${index}`, { notice, signature: signJsonNotice(this.contract, notice, actor.secretKey) });
  }
  outcome(hash: string, place: number, actor: InvoiceActor, action: "proposed" | "accepted" | "rejected", o: { result?: string; reason?: string } = {}) {
    const notice = { circle: this.contract, order_hash: hash, milestone: place, actor: actor.account, action, at: this.at(), deliverable_hash: action === "proposed" ? (o.result ?? null) : null, reason: action === "rejected" ? (o.reason ?? null) : null };
    return this.call("POST", `/orders/${hash}/outcomes`, { notice, signature: signJsonNotice(this.contract, notice, actor.secretKey) });
  }
  /** The proofs as the SDK reads them: a delegate's claims come in camelCase and are turned into `proposal_id` and `proposal_kind`. */
  async proofs(hash: string): Promise<{ items: OnchainProof[]; maxProofs: number }> {
    const raw = (await this.call("GET", `/orders/${hash}/onchain-proofs`)) as { items: Array<Record<string, unknown>>; maxProofs: number };
    const items = raw.items.map((p): OnchainProof =>
      p.proposalId === undefined
        ? (p as unknown as OnchainProof)
        : { txHash: String(p.txHash), method: String(p.method), signer: String(p.signer), receiver: String(p.receiver), proposal_id: Number(p.proposalId), action: String(p.action), proposal_kind: String(p.proposalKind) });
    return { items, maxProofs: raw.maxProofs };
  }
}

function signRaw(contract: string, json: string, actor: InvoiceActor): string {
  return signHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), contract), actor.secretKey);
}

/** Pay book for one order on the buyer side: remembers the milestones and proofs already paid (BE-062 review, F4 and F5). */
export const ledgerFor = (order: OrderDocument): OrderLedger => new OrderLedger(order);

/** The buyer pays a confirmed milestone: a voucher from the actual pair state, signed, ready for the seller to register; the same milestone twice is rejected by the book. */
export function payMilestone(ledger: OrderLedger, index: number, epoch: number, state: InvoicePairState, buyer: InvoiceActor): Voucher {
  return ledger.payMilestone({ index, epoch, state, secretKey: buyer.secretKey });
}

/** Buyer agent for keeper or solver services: one voucher per matching proof, not through the budget, and never twice. */
export function payProofs(ledger: OrderLedger, epoch: number, state: InvoicePairState, proofs: readonly OnchainProof[], buyer: InvoiceActor, mandate?: DelegateMandate) {
  return ledger.payProofs({ epoch, state, proofs, secretKey: buyer.secretKey, ...(mandate ? { mandate } : {}) });
}
