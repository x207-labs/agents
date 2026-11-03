// Agen yang menjual dan membeli lisensi konten (AG-027, pipeline P7, ADR-46) dengan format SDK (SD-070): berkas dienkripsi, penjual memasang ciphertext di sumber mana saja, kunci
// disegel ke pembeli, voucher pembeli ditahan buku sampai isi cocok, dan berkas yang salah dibuktikan dengan bukti curang. Hanya paket publik (`@x207/core`) dan HTTP; mendaftarkan
// voucher ke kontrak dilakukan penjual setelah buku melepasnya, bukan urusan buku.
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

/** Penjual menyiapkan lisensi: hash isi, enkripsi, dokumen lisensi, dan listing bertanda tangan dengan `detail` yang diminta buku. `claimedPlain` memungkinkan skenario penjual curang. */
export async function listLicense(book: LicenseBook, seller: LicenseActor, o: {
  plain: Uint8Array; assetType: string; licenseId: string; exclusive?: boolean; nonce: string; price: string; expiresAt: number; claimedPlain?: Uint8Array
}): Promise<Sold> {
  const { ciphertext, key } = encryptContent(o.plain);
  const doc: LicenseDocument = {
    circle: book.contract, seller: seller.account, content_hash: contentHash(o.claimedPlain ?? o.plain), license_id: o.licenseId, license_hash: sha256Hex("terms of the license"),
    preview_hash: null, exclusive: o.exclusive ?? false, nonce: o.nonce,
  };
  const docHash = licenseDocumentHash(doc);
  const listing: Listing = {
    circle: book.contract, account: seller.account,
    offer: { asset_type: o.assetType, asset_class: "B", quantity: 1, value: o.price },
    want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: o.price },
    terms: "license of the content", detail: JSON.stringify({ kind: "license", asset_type: o.assetType, license_doc: docHash, content_hash: doc.content_hash, license_id: doc.license_id, license_hash: doc.license_hash, exclusive: doc.exclusive }),
    expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `lic-${o.nonce}`,
  };
  await book.postListing(listing, seller.secretKey);
  return { listing, listingHash: listingHash(listing), doc, docHash, plain: o.plain, ciphertext, key };
}

/** Pembeli membayar dengan voucher yang ditahan buku: melanjutkan keadaan pasangan di epoch yang terbuka. */
export function buyLicense(book: LicenseBook, buyer: InvoiceActor, sold: Sold, epoch: number, state: { seq: number; cumulative: string }): Promise<PurchaseState> {
  const voucher: UnsignedVoucher = {
    circle: book.contract, payer: buyer.account, payee: sold.listing.account, epoch, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulative) + BigInt(sold.listing.offer.value)).toString(), unit: "credit", resource: licenseResource(sold.docHash),
  };
  return book.purchase(sold.listingHash, voucher, buyer.secretKey);
}

/** Penjual mencatat ciphertext di sumber lalu melepas kunci yang disegel ke pembeli. */
export async function serveLicense(book: LicenseBook, seller: LicenseActor, id: string, sold: Sold, source: ContentRef, buyer: LicenseActor): Promise<PurchaseState> {
  const posted = { circle: book.contract, purchase_id: id, actor: seller.account, action: "cipher_posted", at: book.at(), source, cipher_hash: contentHash(sold.ciphertext) };
  await book.notice(id, posted, signJsonNotice(book.contract, posted, seller.secretKey));
  const { release, signature } = createRelease({
    circle: book.contract, license_hash: sold.docHash, buyer: buyer.account, buyerPublicKey: buyer.publicKey, content_hash: sold.doc.content_hash, content_size: sold.plain.length, ciphertext: sold.ciphertext,
    contentKey: sold.key, at: book.at(), sellerSecretKey: seller.secretKey as string,
  });
  return book.notice(id, release, signature);
}

export type Received = { outcome: "confirmed" | "disputed" | "refused"; content?: Uint8Array; status?: PurchaseState["status"]; reason?: string; proof?: CheatProof }

/**
 * Pembeli mengunduh dari sumber, memeriksa `cipher_hash`, rilis, dan isi. Cocok: konfirmasi. Tidak cocok: sengketa dengan bukti curang tanpa ciphertext (buku mengunduhnya sendiri
 * dari sumber). Salah sumber atau tanda tangan bukan kecurangan penjual dan tidak menjadi bukti.
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
  const verdict = verifyDelivery({ ciphertext, release: view.release, signature: view.releaseSignature, sellerPublicKey, buyerSecretKey: buyer.secretKey as string });
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

/** Pembeli nakal: menyengketakan berkas yang benar dengan bukti buatan sendiri (kunci kotaknya diserahkan, berkasnya benar). */
export async function falseDispute(book: LicenseBook, buyer: LicenseActor, id: string): Promise<PurchaseState> {
  const view = await book.get(id);
  const boxKey = Buffer.from(deriveBoxKey(Buffer.from(view.release.sealed_key, "hex"), buyer.secretKey as string)).toString("hex");
  const notice = { circle: book.contract, purchase_id: id, actor: buyer.account, action: "disputed", at: book.at(), reason: "content_mismatch", proof: { release: view.release, signature: view.releaseSignature, box_key: boxKey } };
  return book.notice(id, notice, signJsonNotice(book.contract, notice, buyer.secretKey));
}
