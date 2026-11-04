// Agent that sells and buys content licenses (AG-027, pipeline P7, ADR-46) in the SDK format (SD-070): the file is encrypted, the seller places the ciphertext at any source, the key is
// sealed to the buyer, the buyer's voucher is held by the book until the content matches, and a wrong file is proven with fraud proof. Only the public package (`@x207/core`) and HTTP; registering the
// voucher with the contract is done by the seller after the book releases it, not by the book.
import {
  contentHash, createRelease, deriveBoxKey, encryptContent, fetchCiphertext, licenseDocumentHash, licenseResource, listingHash, signListing, signVoucher, verifyDelivery,
  type CheatProof, type ContentRef, type ContentSource, type Listing, type LicenseDocument, type UnsignedVoucher, type VoucherSecretKey,
} from "@x207/core";
import { createHash } from "node:crypto";
import { BookError, signJsonNotice, type InvoiceActor } from "./invoice-book.ts";

export type LicenseActor = InvoiceActor & { publicKey: string };
export type PurchaseState = {
  purchaseId: string; listingHash: string; buyer: string; seller: string; status: "paid_held" | "cipher_posted" | "key_released" | "confirmed" | "disputed" | "refuted" | "cancelled"
  contentHash: string; exclusive: boolean; needsBond: boolean; source: ContentRef | null; cipherHash: string | null; release: any | null; releaseSignature: string | null
  disputeUntil: number | null; autoConfirmed: boolean; voucher?: UnsignedVoucher; voucherSignature?: string
};

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export class LicenseBook {
  protected readonly base: string;
  protected readonly circleId: string;
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

  protected async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}/x207/circles/${this.circleId}${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json: any = await res.json();
    if (!res.ok) throw new BookError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "");
    return json;
  }
  postListing(listing: Listing, secretKey: VoucherSecretKey) {
    return this.call("POST", "/listings", { listing, signature: signListing(listing, secretKey) });
  }
  purchase(hash: string, voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Promise<PurchaseState> {
    return this.call("POST", `/listings/${hash}/purchases`, { voucher, signature: signVoucher(voucher, secretKey).signature });
  }
  get(id: string): Promise<PurchaseState> {
    return this.call("GET", `/purchases/${id}`);
  }
  notice(id: string, notice: object, signature: string): Promise<PurchaseState> {
    return this.call("POST", `/purchases/${id}`, { notice, signature });
  }
}

export type Sold = { listing: Listing; listingHash: string; doc: LicenseDocument; docHash: string; plain: Uint8Array; ciphertext: Uint8Array; key: Uint8Array }

/** The seller prepares the license: content hash, encryption, license document, and signed listing with the `detail` the book requests. `claimedPlain` allows a cheating-seller scenario. */
export async function listLicense(book: LicenseBook, seller: LicenseActor, o: {
  plain: Uint8Array; assetType: string; licenseId: string; exclusive?: boolean; nonce: string; price: string; expiresAt: number; claimedPlain?: Uint8Array
  /** The text of the license; its sha256 is the `license_hash` of the listing. Default: a fixed placeholder text. */
  terms?: string
}): Promise<Sold> {
  const { ciphertext, key } = encryptContent(o.plain);
  const doc: LicenseDocument = {
    circle: book.contract, seller: seller.account, content_hash: contentHash(o.claimedPlain ?? o.plain), license_id: o.licenseId, license_hash: sha256Hex(o.terms ?? "terms of the license"),
    preview_hash: null, exclusive: o.exclusive ?? false, nonce: o.nonce,
  };
  const docHash = licenseDocumentHash(doc);
  const listing: Listing = {
    circle: book.contract, account: seller.account,
    offer: { asset_type: o.assetType, asset_class: "B", quantity: 1, value: o.price },
    want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: o.price },
    terms: o.terms ?? "license of the content", detail: JSON.stringify({ kind: "license", asset_type: o.assetType, license_doc: docHash, content_hash: doc.content_hash, license_id: doc.license_id, license_hash: doc.license_hash, exclusive: doc.exclusive }),
    expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `lic-${o.nonce}`,
  };
  await book.postListing(listing, seller.secretKey);
  return { listing, listingHash: listingHash(listing), doc, docHash, plain: o.plain, ciphertext, key };
}

/** The buyer pays with a voucher that the book holds: continues the pair state in the open epoch. */
export function buyLicense(book: LicenseBook, buyer: InvoiceActor, sold: Sold, epoch: number, state: { seq: number; cumulative: string }): Promise<PurchaseState> {
  const voucher: UnsignedVoucher = {
    circle: book.contract, payer: buyer.account, payee: sold.listing.account, epoch, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulative) + BigInt(sold.listing.offer.value)).toString(), unit: "credit", resource: licenseResource(sold.docHash),
  };
  return book.purchase(sold.listingHash, voucher, buyer.secretKey);
}

/** The seller records the ciphertext at the source then releases the sealed key to the buyer. */
export async function serveLicense(book: LicenseBook, seller: LicenseActor, id: string, sold: Sold, source: ContentRef, buyer: LicenseActor): Promise<PurchaseState> {
  const posted = { circle: book.contract, purchase_id: id, actor: seller.account, action: "cipher_posted", at: book.at(), source, cipher_hash: contentHash(sold.ciphertext) };
  await book.notice(id, posted, signJsonNotice(book.contract, posted, seller.secretKey));
  const { release, signature } = createRelease({
    circle: book.contract, license_hash: sold.docHash, buyer: buyer.account, buyerPublicKey: buyer.publicKey, content_hash: sold.doc.content_hash, content_size: sold.plain.length, purchase_id: id, ciphertext: sold.ciphertext,
    contentKey: sold.key, at: book.at(), sellerSecretKey: seller.secretKey as string,
  });
  return book.notice(id, release, signature);
}

export type Received = { outcome: "confirmed" | "disputed" | "refused"; content?: Uint8Array; status?: PurchaseState["status"]; reason?: string; proof?: CheatProof }

/**
 * The buyer downloads from the source and checks `cipher_hash`, the release, and the content. Match: confirm. No match: dispute with fraud proof without the ciphertext (the book downloads it itself
 * from the source). A wrong source or signature is not seller fraud and is not proof.
 */
export async function receiveLicense(book: LicenseBook, buyer: LicenseActor, id: string, sellerPublicKey: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>): Promise<Received> {
  const view = await book.get(id);
  if (view.source === null || view.cipherHash === null || view.release === null || view.releaseSignature === null) return { outcome: "refused", reason: "the seller has not released the key" };
  let ciphertext: Uint8Array;
  try {
    ciphertext = await fetchCiphertext(view.source, view.cipherHash, sources);
  } catch (e) {
    return { outcome: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
  const verdict = verifyDelivery({ ciphertext, release: view.release, signature: view.releaseSignature, sellerPublicKey, buyerSecretKey: buyer.secretKey as string, purchaseId: id });
  const notify = async (action: "confirmed" | "disputed", reason: string | null, proof: object | null) => {
    const notice = { circle: book.contract, purchase_id: id, actor: buyer.account, action, at: book.at(), reason, proof };
    return book.notice(id, notice, signJsonNotice(book.contract, notice, buyer.secretKey));
  };
  if (verdict.ok) {
    const after = await notify("confirmed", null, null);
    return { outcome: "confirmed", content: verdict.content, status: after.status };
  }
  if ("proof" in verdict) {
    const { release, signature, box_key } = verdict.proof;
    const after = await notify("disputed", "content_mismatch", { release, signature, box_key });
    return { outcome: "disputed", reason: verdict.reason, proof: verdict.proof, status: after.status };
  }
  return { outcome: "refused", reason: verdict.reason };
}

/** Rogue buyer: disputes a correct file with self-made proof (the box key is handed over, the file is correct). */
export async function falseDispute(book: LicenseBook, buyer: LicenseActor, id: string): Promise<PurchaseState> {
  const view = await book.get(id);
  const boxKey = Buffer.from(deriveBoxKey(Buffer.from(view.release.sealed_key, "hex"), buyer.secretKey as string)).toString("hex");
  const notice = { circle: book.contract, purchase_id: id, actor: buyer.account, action: "disputed", at: book.at(), reason: "content_mismatch", proof: { release: view.release, signature: view.releaseSignature, box_key: boxKey } };
  return book.notice(id, notice, signJsonNotice(book.contract, notice, buyer.secretKey));
}
