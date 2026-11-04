// Agents that sell and buy a thing through the official feature of its platform (AG-031, pipeline P4, ADR-49) with the format of the SDK (SD-077): the transfer document and its hash,
// the resource `x207:transfer:<hash>`, the TXT texts of the DNS proof, and the voucher of the buyer. The book is the real transfer ledger of the backend (BE-074) over HTTP: the voucher of the
// buyer is held there until the platform shows that the transfer happened. Three proofs: a domain (the seller sets `x207-sell=<listing_hash>` before the listing, the buyer sets
// `x207-own=<transfer id>-<token>` after the transfer, the text that the purchase answer gives it), a game item (the trade offer is accepted and its hold is over), a ticket (the buyer confirms). A seller who does not transfer is not paid:
// the window of the platform passes and the voucher never moves. The agents talk to the platform only through the book; the platforms themselves (the registrar, Steam) are what the tests mock.
import {
  listingHash, normalizeTransfer, sellTxt, signVoucher, transferDocumentHash, transferVoucher,
  type Listing, type TransferDocument, type TransferPlatform, type UnsignedVoucher, type VoucherSecretKey,
} from "@x207/core";
import { BookError, signJsonNotice, type InvoiceActor } from "./invoice-book.ts";
import { LicenseBook } from "./license.ts";

export type TransferActor = InvoiceActor;

/** The transfer as the book shows it; `voucher` is there only when the proof is met (the voucher goes to the seller side). */
export type TransferState = {
  transferId: number; listingHash: string; buyer: string; seller: string; platform: TransferPlatform; proofMethod: string; transferRef: string;
  status: "paid_held" | "confirmed" | "cancelled"; windowUntil: number; tradeOfferId: string | null; proof: Record<string, unknown> | null; cancelReason: string | null;
  /** The buyer asked to cancel a transfer that has an objective proof: the voucher is still held and the proof can still pay the seller until the window ends. */
  cancelRequested?: boolean;
  voucher?: UnsignedVoucher; voucherSignature?: string; instructions?: { setTxtAfterTransfer: string; on: string };
}

/** What a check of the proof said: the book answers with the state, or with a refusal that carries what is missing. */
export type ProofResult =
  | { outcome: "confirmed"; transfer: TransferState }
  | { outcome: "pending"; missing: Record<string, unknown> }
  | { outcome: "unavailable"; missing: Record<string, unknown> }
  | { outcome: "too_soon"; retryAfterSeconds: number }
  | { outcome: "window_passed" }

const ASSET_TYPE: Record<TransferPlatform, string> = { domain: "transfer:domain", game_item: "transfer:game-item", ticket: "transfer:ticket" };

export class HttpTransferBook extends LicenseBook {
  /** `POST /listings/{hash}/transfers`: the voucher is held by the book; a game item names the Steam account of the buyer. */
  buy(hash: string, voucher: UnsignedVoucher, secretKey: VoucherSecretKey, buyerRef?: string): Promise<TransferState> {
    return this.call("POST", `/listings/${hash}/transfers`, { voucher, signature: signVoucher(voucher, secretKey).signature, ...(buyerRef === undefined ? {} : { buyer_ref: buyerRef }) });
  }
  getTransfer(id: number): Promise<TransferState> {
    return this.call("GET", `/transfers/${id}`);
  }
  /** The signed notice of the buyer (`confirmed`, for a ticket) or of either party (`cancelled`, while the voucher is held). */
  async transferNotice(id: number, actor: TransferActor, action: "confirmed" | "cancelled"): Promise<TransferState> {
    const notice = { circle: this.contract, transfer_id: id, actor: actor.account, action, at: this.at() };
    return this.call("POST", `/transfers/${id}`, { notice, signature: signJsonNotice(this.contract, notice, actor.secretKey) });
  }
  /** `POST /transfers/{id}/proof`: objective, so it needs no signature; the answer says what is missing when the proof is not met. */
  async proof(id: number, body: { tradeoffer_id?: string } = {}): Promise<ProofResult> {
    const res = await fetch(`${this.base}/x207/circles/${this.circleId}/transfers/${id}/proof`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json: any = await res.json();
    if (res.ok) return { outcome: "confirmed", transfer: json };
    const code = json?.error?.code as string | undefined;
    if (code === "transfer_proof_pending") return { outcome: "pending", missing: json.error.details ?? {} };
    if (code === "transfer_platform_unavailable") return { outcome: "unavailable", missing: json.error.details ?? {} };
    if (code === "rate_limited") return { outcome: "too_soon", retryAfterSeconds: Number(json.error.details?.retryAfterSeconds ?? 0) };
    if (code === "transfer_window_passed") return { outcome: "window_passed" };
    throw new BookError(res.status, code ?? "http_error", json?.error?.message ?? "");
  }
}

/** The pair of a buyer and a seller as the buyer keeps it: the last `seq` and the `cumulative` of the vouchers that the book still holds (the contract state is the base). */
export type PairState = { seq: number; cumulative: string }

export type PreparedTransfer = {
  listing: Listing; listingHash: string; doc: TransferDocument; docHash: string;
  /** For a domain: the TXT text that the seller must set on the domain BEFORE the listing is posted; `null` for the other platforms. */
  sellerTxt: string | null;
}

/** The seller prepares the document (the SDK refuses a bad one with a `TransferError` before anything is sent) and the signed listing. */
export function prepareTransfer(book: LicenseBook, seller: TransferActor, o: { platform: TransferPlatform; ref: string; price: string; estimateSeconds: number; nonce: string; expiresAt: number }): PreparedTransfer {
  const method = o.platform === "domain" ? "dns_txt" : o.platform === "game_item" ? "trade_api" : "buyer_confirm";
  const doc = normalizeTransfer({ circle: book.contract, seller: seller.account, platform: o.platform, transfer_ref: o.ref, proof_method: method, estimate_seconds: o.estimateSeconds, value: o.price, nonce: o.nonce });
  const docHash = transferDocumentHash(doc);
  const listing: Listing = {
    circle: book.contract, account: seller.account,
    offer: { asset_type: ASSET_TYPE[o.platform], asset_class: "B", quantity: 1, value: o.price },
    want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: o.price },
    terms: `transfer of a ${o.platform} through its platform`,
    detail: JSON.stringify({ kind: "transfer", transfer_doc: docHash, platform: doc.platform, transfer_ref: doc.transfer_ref, proof_method: doc.proof_method, estimate_seconds: doc.estimate_seconds, nonce: doc.nonce }),
    expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `transfer-${o.nonce}`,
  };
  const hash = listingHash(listing);
  return { listing, listingHash: hash, doc, docHash, sellerTxt: o.platform === "domain" ? sellTxt(hash) : null };
}

/** Posts the listing. For a domain the TXT `x207-sell=<listing_hash>` must already be on the domain, or the book refuses with `transfer_seller_unproven`. */
export function postTransfer(book: LicenseBook, seller: TransferActor, prepared: PreparedTransfer): Promise<unknown> {
  return book.postListing(prepared.listing, seller.secretKey);
}

/** The buyer pays with the voucher of the SDK that continues the pair; the book holds it. `pair` is updated, so the next purchase from the same seller continues from this one. */
export async function buyTransfer(book: HttpTransferBook, buyer: TransferActor, prepared: PreparedTransfer, epoch: number, pair: PairState, buyerRef?: string): Promise<TransferState> {
  const voucher = transferVoucher({ doc: prepared.doc, buyer: buyer.account, epoch, state: { seq: pair.seq, cumulativeAmount: pair.cumulative } });
  const bought = await book.buy(prepared.listingHash, voucher, buyer.secretKey, buyerRef);
  pair.seq = voucher.seq;
  pair.cumulative = voucher.cumulativeAmount;
  return bought;
}

/** A purchase that was cancelled never moved its voucher: the pair goes back to what it was before it, so that the next voucher does not skip a number. */
export function releasePair(pair: PairState, before: PairState): void {
  pair.seq = before.seq;
  pair.cumulative = before.cumulative;
}

/**
 * The text that the buyer of a domain sets on it once the registrar has moved it. Since UM-096 the backend gives it in the answer of the purchase (`instructions.setTxtAfterTransfer`,
 * `x207-own=<transfer id>-<token>`, the token derived from the voucher signature of the buyer), so a third party cannot predict it from the transfer id: read it from there.
 */
export const buyerTxt = (transfer: Pick<TransferState, "transferId" | "instructions">): string => {
  const given = transfer.instructions?.setTxtAfterTransfer;
  if (given === undefined) throw new Error(`transfer ${transfer.transferId}: the answer of the purchase has no instructions.setTxtAfterTransfer`);
  return given;
};

/** The buyer asks the book to check the proof now, and again until it is met or the window ends; `wait` is the pause of the agent between two asks. */
export async function waitForProof(book: HttpTransferBook, id: number, o: { tradeOfferId?: string; tries: number; wait: () => Promise<void> }): Promise<ProofResult> {
  let last: ProofResult = { outcome: "pending", missing: {} };
  for (let i = 0; i < o.tries; i++) {
    last = await book.proof(id, o.tradeOfferId === undefined ? {} : { tradeoffer_id: o.tradeOfferId });
    if (last.outcome === "confirmed" || last.outcome === "window_passed") return last;
    await o.wait();
  }
  return last;
}

/** The seller side of a settled sale: the voucher that the book released, ready to be registered by the seller. */
export function releasedVoucher(transfer: TransferState): { voucher: UnsignedVoucher; signature: string } {
  if (transfer.status !== "confirmed" || transfer.voucher === undefined || transfer.voucherSignature === undefined) throw new BookError(409, "transfer_bad_state", `the transfer is ${transfer.status}: no voucher was released`);
  return { voucher: transfer.voucher, signature: transfer.voucherSignature };
}
