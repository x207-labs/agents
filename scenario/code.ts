// Agen yang menjual dan membeli kode sekali tukar (AG-030, pipeline P3, ADR-48) dengan format SDK (SD-076): kode dan salt dienkripsi, listing hanya memuat `code_commitment`,
// kunci disegel ke pembeli, voucher pembeli ditahan buku, dan penerbit dicek sebelum kunci dilepas. Buku kode di sini TIRUAN (`MockCodeBook`) dan penerbitnya tiruan
// (`MockCodeIssuer`); keduanya memakai antarmuka `CodeBookApi` yang akan dipenuhi buku asli BE-069 lewat HTTP, jadi fungsi penjual dan pembeli di bawah tidak berubah saat buku
// asli ada: cukup beri `HttpCodeBook` yang memetakan lima method ke rute backend. Nama error tiruan mengikuti `backend/docs/code-book.md` (usulan, belum final).
//
// Bagian kedua: proxy rahasia (`SecretProxy`, BE-070) untuk kunci API yang dijual per panggilan: kunci asli hanya ada di proxy milik pemberi, tagihan satu unit per panggilan yang
// berhasil, dan hitungan pembeli (`BuyerMeter`, SD-068) harus sama dengan tagihan.
import {
  CODE_DISPUTE_WINDOW_SECONDS, checkCodeDocument, codeCommitment, codeDocumentHash, codeNeedsBond, codeResource, contentHash, createCodeRelease, encryptCode, fetchCiphertext, listingHash,
  signListing, signVoucher, verifyCodeDelivery, verifyListingSignature, verifyVoucher, voucherPublicKey,
  type CodeCheck, type CodeDocument, type CodeIssuer, type ContentRef, type ContentSource, type Listing, type UnsignedVoucher, type Voucher, type VoucherSecretKey,
} from "@x207/core";
import { BuyerMeter } from "@x207/scheme";
import { BookError, signJsonNotice, type InvoiceActor } from "./invoice-book.ts";

export type CodeActor = InvoiceActor & { publicKey: string };

/** Penerbit tiruan: menyimpan kode yang diterbitkan; `markUsed` menandai kode terpakai (ditebus di tempat lain). */
export class MockCodeIssuer implements CodeIssuer {
  readonly name: string;
  private readonly state = new Map<string, "valid" | "used">();
  readonly asked: string[] = [];
  constructor(name: string) {
    this.name = name;
  }
  issue(code: string): void {
    this.state.set(code, "valid");
  }
  markUsed(code: string): void {
    if (this.state.has(code)) this.state.set(code, "used");
  }
  /** Pembeli menebus kode di penerbit: berhasil sekali. */
  redeem(code: string): boolean {
    if (this.state.get(code) !== "valid") return false;
    this.state.set(code, "used");
    return true;
  }
  async checkCode(code: string): Promise<CodeCheck> {
    this.asked.push(code);
    return this.state.get(code) ?? "unknown";
  }
}

export type CodePurchase = {
  purchaseId: string; listingHash: string; buyer: string; seller: string; status: "paid_held" | "cipher_posted" | "key_released" | "confirmed" | "cancelled"
  contentHash: string; source: ContentRef | null; cipherHash: string | null; release: any | null; releaseSignature: string | null; disputeUntil: number | null
  voucher?: Voucher
}

/** Yang dipakai penjual dan pembeli dari buku kode; buku asli (BE-069) memetakan ini ke rute HTTP. */
export interface CodeBookApi {
  readonly contract: string;
  at(): number;
  postListing(listing: Listing, secretKey: VoucherSecretKey): Promise<unknown>;
  purchase(hash: string, voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Promise<CodePurchase>;
  get(id: string): Promise<CodePurchase>;
  notice(id: string, notice: any, signature: string): Promise<CodePurchase>;
  /** Penjual menunjukkan kode sekali agar penerbit dicek; buku menyimpan hanya putusannya. Melempar `code_used`, `code_unknown`, atau `code_issuer_unknown`. */
  check(commitment: string, code: string, salt: string): Promise<{ verdict: CodeCheck; checkedAt: number }>;
}

type Held = CodePurchase & { ciphertext?: Uint8Array; voucherHeld?: Voucher; price: string }

/** Buku kode tiruan, di memori. Tidak menyimpan kode, salt, atau kunci berkas; hanya putusan penerbit dan waktunya. */
export class MockCodeBook implements CodeBookApi {
  readonly contract: string;
  private readonly now: () => number;
  private readonly publicKeys: Record<string, string>;
  private readonly issuers: Record<string, CodeIssuer>;
  private readonly listings = new Map<string, { listing: Listing; detail: any }>();
  private readonly purchases = new Map<string, Held>();
  private readonly verdicts = new Map<string, { verdict: CodeCheck; checkedAt: number }>();
  private readonly fetchSource: (ref: ContentRef) => Promise<Uint8Array>;
  private next = 1;

  constructor(o: { contract: string; now: () => number; publicKeys: Record<string, string>; issuers: Record<string, CodeIssuer>; fetchSource: (ref: ContentRef) => Promise<Uint8Array> }) {
    this.contract = o.contract;
    this.now = o.now;
    this.publicKeys = o.publicKeys;
    this.issuers = o.issuers;
    this.fetchSource = o.fetchSource;
  }
  at(): number {
    return this.now();
  }
  /** Semua yang disimpan buku, untuk memeriksa bahwa kode dan salt tidak ada. */
  dump(): string {
    return JSON.stringify({ listings: [...this.listings.values()], purchases: [...this.purchases.values()].map(({ ciphertext: _c, ...p }) => p), verdicts: [...this.verdicts.entries()] });
  }

  async postListing(listing: Listing, secretKey: VoucherSecretKey): Promise<unknown> {
    const key = this.publicKeys[listing.account];
    if (!key || !verifyListingSignature(listing, signListing(listing, secretKey), key)) throw new BookError(401, "bad_signature", "listing signature");
    let detail: any;
    try {
      detail = JSON.parse(listing.detail);
    } catch {
      throw new BookError(400, "code_format_invalid", "detail is not JSON");
    }
    if (detail.kind !== "code" || typeof detail.code_commitment !== "string" || typeof detail.issuer !== "string") throw new BookError(400, "code_format_invalid", "not a code listing");
    if (detail.issuer !== "none" && !this.issuers[detail.issuer]) throw new BookError(400, "code_issuer_unknown", detail.issuer);
    const verifiable = detail.issuer !== "none" && detail.verifiable === true;
    if (codeNeedsBond({ value: listing.offer.value, verifiable, arbiter: detail.arbiter ?? null })) throw new BookError(400, "code_value_over_cap", "not checkable, above 20 credit, no bond");
    const hash = listingHash(listing);
    this.listings.set(hash, { listing, detail: { ...detail, verifiable } });
    return { listingHash: hash };
  }

  async purchase(hash: string, voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Promise<CodePurchase> {
    const entry = this.listings.get(hash);
    if (!entry) throw new BookError(404, "listing_not_found", hash);
    const signed = signVoucher(voucher, secretKey);
    const buyerKey = this.publicKeys[voucher.payer];
    if (!buyerKey || !verifyVoucher(signed, buyerKey)) throw new BookError(401, "bad_signature", "voucher signature");
    if (voucher.payee !== entry.listing.account || voucher.resource !== codeResource(entry.detail.code_doc)) throw new BookError(400, "voucher_mismatch", "payee or resource");
    const id = `cp-${this.next++}`;
    const p: Held = {
      purchaseId: id, listingHash: hash, buyer: voucher.payer, seller: entry.listing.account, status: "paid_held", contentHash: entry.detail.code_commitment, source: null, cipherHash: null,
      release: null, releaseSignature: null, disputeUntil: null, voucherHeld: signed, price: entry.listing.offer.value,
    };
    this.purchases.set(id, p);
    return this.view(p);
  }
  async get(id: string): Promise<CodePurchase> {
    return this.view(this.must(id));
  }
  private must(id: string): Held {
    const p = this.purchases.get(id);
    if (!p) throw new BookError(404, "purchase_not_found", id);
    return p;
  }
  /** The voucher of the buyer is in no answer until the purchase is confirmed. */
  private view(p: Held): CodePurchase {
    const { ciphertext: _c, voucherHeld, price: _p, ...rest } = p;
    return { ...rest, ...(p.status === "confirmed" && voucherHeld ? { voucher: voucherHeld } : {}) };
  }

  async notice(id: string, notice: any, _signature: string): Promise<CodePurchase> {
    const p = this.must(id);
    if (p.status === "cancelled") throw new BookError(409, "purchase_cancelled", id);
    if (notice.action === "cipher_posted") {
      p.source = notice.source;
      p.cipherHash = notice.cipher_hash;
      p.status = "cipher_posted";
      return this.view(p);
    }
    if (notice.action === "confirmed") {
      if (p.status !== "key_released") throw new BookError(409, "purchase_bad_state", p.status);
      p.status = "confirmed";
      return this.view(p);
    }
    if (typeof notice.sealed_key === "string") {
      const detail = this.listings.get(p.listingHash)!.detail;
      if (detail.verifiable) {
        const verdict = this.verdicts.get(p.contentHash);
        if (!verdict || this.now() - verdict.checkedAt > 600) throw new BookError(409, "code_not_checked", "the issuer was not asked, or the answer is old");
        if (verdict.verdict !== "valid") throw new BookError(409, verdict.verdict === "used" ? "code_used" : "code_unknown", "the issuer did not say valid");
      }
      if (p.cipherHash === null || notice.cipher_hash !== p.cipherHash) throw new BookError(409, "cipher_hash_mismatch", "release is for another ciphertext");
      p.release = notice;
      p.releaseSignature = _signature;
      p.disputeUntil = this.now() + CODE_DISPUTE_WINDOW_SECONDS;
      p.status = "key_released";
      return this.view(p);
    }
    throw new BookError(400, "notice_unknown", String(notice.action));
  }

  async check(commitment: string, code: string, salt: string): Promise<{ verdict: CodeCheck; checkedAt: number }> {
    const entry = [...this.listings.values()].find((l) => l.detail.code_commitment === commitment);
    if (!entry) throw new BookError(404, "listing_not_found", "no listing with this commitment");
    const saltBytes = Uint8Array.from(Buffer.from(salt, "hex"));
    let ok = false;
    try {
      ok = codeCommitment(code, saltBytes) === commitment;
    } catch {
      ok = false;
    }
    if (!ok) throw new BookError(400, "code_format_invalid", "code and salt do not match the commitment");
    const issuer = this.issuers[entry.detail.issuer];
    if (!issuer) throw new BookError(400, "code_issuer_unknown", entry.detail.issuer);
    const verdict = await issuer.checkCode(code); // the code goes to the issuer only; the book keeps the verdict
    const record = { verdict, checkedAt: this.now() };
    this.verdicts.set(commitment, record);
    if (verdict === "used") {
      // a used code cannot be sold: every open purchase of it is cancelled and its voucher is let go
      for (const p of this.purchases.values()) if (p.contentHash === commitment && p.status !== "confirmed") { p.status = "cancelled"; delete p.voucherHeld; }
      throw new BookError(409, "code_used", "the issuer says the code is used");
    }
    if (verdict === "unknown") throw new BookError(409, "code_unknown", "the issuer does not know the code");
    return record;
  }
}

export type SoldCode = { listing: Listing; listingHash: string; doc: Required<CodeDocument>; docHash: string; code: string; salt: Uint8Array; ciphertext: Uint8Array; key: Uint8Array }

/** Penjual menyiapkan kode: salt, enkripsi, dokumen (batas 20 credit dijaga SDK), dan listing bertanda tangan. Melempar `CodeError` dari SDK sebelum apa pun dikirim. */
export async function listCode(book: CodeBookApi, seller: CodeActor, o: {
  code: string; issuer: string; verifiable: boolean; price: string; arbiter?: string | null; nonce: string; expiresAt: number; assetType?: string
}): Promise<SoldCode> {
  const { ciphertext, key, code_commitment, salt } = encryptCode(o.code);
  const doc = checkCodeDocument({ circle: book.contract, seller: seller.account, code_commitment, issuer: o.issuer, value: o.price, verifiable: o.verifiable, arbiter: o.arbiter ?? null, nonce: o.nonce });
  const docHash = codeDocumentHash(doc);
  const listing: Listing = {
    circle: book.contract, account: seller.account,
    offer: { asset_type: o.assetType ?? "code:gift", asset_class: "D", quantity: 1, value: o.price },
    want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: o.price },
    terms: "one-time code", detail: JSON.stringify({ kind: "code", code_doc: docHash, code_commitment, issuer: o.issuer, value: o.price, verifiable: o.verifiable, ...(doc.arbiter ? { arbiter: doc.arbiter, bond: true } : {}) }),
    expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `code-${o.nonce}`,
  };
  await book.postListing(listing, seller.secretKey);
  return { listing, listingHash: listingHash(listing), doc, docHash, code: o.code, salt, ciphertext, key };
}

/** Pembeli membayar dengan voucher yang ditahan buku. */
export function buyCode(book: CodeBookApi, buyer: InvoiceActor, sold: SoldCode, epoch: number, state: { seq: number; cumulative: string }): Promise<CodePurchase> {
  const voucher: UnsignedVoucher = {
    circle: book.contract, payer: buyer.account, payee: sold.listing.account, epoch, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulative) + BigInt(sold.listing.offer.value)).toString(), unit: "credit", resource: codeResource(sold.docHash),
  };
  return book.purchase(sold.listingHash, voucher, buyer.secretKey);
}

/** Penjual mencatat ciphertext, menunjukkan kode ke buku untuk cek penerbit (bila bisa dicek), lalu melepas kunci yang disegel. */
export async function serveCode(book: CodeBookApi, seller: CodeActor, id: string, sold: SoldCode, source: ContentRef, buyer: CodeActor): Promise<CodePurchase> {
  const posted = { circle: book.contract, purchase_id: id, actor: seller.account, action: "cipher_posted", at: book.at(), source, cipher_hash: contentHash(sold.ciphertext) };
  await book.notice(id, posted, signJsonNotice(book.contract, posted, seller.secretKey));
  if (sold.doc.verifiable) await book.check(sold.doc.code_commitment, sold.code, Buffer.from(sold.salt).toString("hex"));
  const { release, signature } = createCodeRelease({
    doc: sold.doc, code: sold.code, salt: sold.salt, buyer: buyer.account, buyerPublicKey: buyer.publicKey, purchase_id: id, ciphertext: sold.ciphertext, contentKey: sold.key, at: book.at(),
    sellerSecretKey: seller.secretKey as string,
  });
  return book.notice(id, release, signature);
}

export type ReceivedCode = { outcome: "confirmed" | "refused"; code?: string; reason?: string; status?: CodePurchase["status"] }

/** Pembeli mengunduh, memeriksa rilis dan isi terhadap `code_commitment`, dan mengonfirmasi bila cocok. Kode hanya ada di tangan pembeli. */
export async function receiveCode(book: CodeBookApi, buyer: CodeActor, id: string, sellerPublicKey: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>): Promise<ReceivedCode> {
  const view = await book.get(id);
  if (view.source === null || view.cipherHash === null || view.release === null || view.releaseSignature === null) return { outcome: "refused", reason: "the seller has not released the key" };
  let ciphertext: Uint8Array;
  try {
    ciphertext = await fetchCiphertext(view.source, view.cipherHash, sources);
  } catch (e) {
    return { outcome: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
  const verdict = verifyCodeDelivery({ ciphertext, release: view.release, signature: view.releaseSignature, sellerPublicKey, buyerSecretKey: buyer.secretKey as string, purchaseId: id });
  if (!verdict.ok) return { outcome: "refused", reason: verdict.reason };
  const notice = { circle: book.contract, purchase_id: id, actor: buyer.account, action: "confirmed", at: book.at(), reason: null, proof: null };
  const after = await book.notice(id, notice, signJsonNotice(book.contract, notice, buyer.secretKey));
  return { outcome: "confirmed", code: verdict.code!, status: after.status };
}

// ---- secret proxy (BE-070): an API key sold per call, the key stays in the proxy of the owner ------------------------------------------------------------------------------

export type ProviderResponse = { status: number; body: string };
/**
 * Proxy rahasia milik pemberi (mode self-hosted): meneruskan panggilan ke penyedia dengan kunci asli, menghapus kunci dari jawaban, dan menagih satu unit per panggilan yang
 * berhasil. Voucher kumulatif yang dikirim bersama panggilan baru dicatat bila penyedia menjawab di bawah 400; panggilan gagal tidak ditagih.
 */
export class SecretProxy {
  readonly unitPrice: string;
  readonly audit: string[] = [];
  billed = 0;
  registered: Voucher | null = null;
  private readonly apiKey: string;
  private readonly provider: (apiKey: string, path: string) => ProviderResponse;
  private readonly buyerPublicKey: string;
  constructor(o: { apiKey: string; unitPrice: string; buyerPublicKey: string; provider: (apiKey: string, path: string) => ProviderResponse }) {
    this.apiKey = o.apiKey;
    this.unitPrice = o.unitPrice;
    this.buyerPublicKey = o.buyerPublicKey;
    this.provider = o.provider;
  }
  /** Pengumuman 402 untuk satu panggilan: satuan `call`, jumlah 1. */
  announce(): { unit: string; quantity: string; unit_price: string; amount: string } {
    return { unit: "call", quantity: "1", unit_price: this.unitPrice, amount: this.unitPrice };
  }
  call(path: string, voucher: Voucher): { status: number; body: string; billed: boolean } {
    const expected = BigInt(this.registered?.cumulativeAmount ?? "0") + BigInt(this.unitPrice);
    if (!verifyVoucher(voucher, this.buyerPublicKey) || BigInt(voucher.cumulativeAmount) !== expected) {
      this.audit.push(`${path} refused: voucher`);
      return { status: 402, body: "payment required", billed: false };
    }
    const answer = this.provider(this.apiKey, path);
    const body = answer.body.split(this.apiKey).join("[redacted]");
    this.audit.push(`${path} ${answer.status}`);
    if (answer.status >= 400) return { status: 502, body: "provider failed", billed: false };
    this.billed += 1;
    this.registered = voucher;
    return { status: 200, body, billed: true };
  }
}

/** Pembeli membayar per panggilan: hitungan sendiri (`BuyerMeter`), voucher kumulatif di atas yang terdaftar, dan hanya panggilan yang sukses dihitung. */
export class SecretBuyer {
  readonly meter: BuyerMeter;
  readonly vouchers: Voucher[] = [];
  private cumulative = 0n;
  private seq = 0;
  private readonly o: { circle: string; buyer: string; seller: string; epoch: number; secretKey: VoucherSecretKey; resource: string };
  constructor(o: { circle: string; buyer: string; seller: string; epoch: number; secretKey: VoucherSecretKey; unitPrice: string; resource: string }) {
    this.o = o;
    this.meter = new BuyerMeter({ unit: "call", unitPrice: o.unitPrice, maxQuantityPerRequest: 1, epoch: o.epoch });
  }
  get received(): string {
    return this.meter.received;
  }
  call(proxy: SecretProxy, path: string): { status: number; body: string } {
    const announcement = proxy.announce();
    this.meter.authorize(announcement, announcement.amount);
    if (this.meter.pending === "0") this.meter.expect(1); // a failed call is not received: it stays expected, it is not asked for twice
    const voucher = this.meter.sign({
      circle: this.o.circle, payer: this.o.buyer, payee: this.o.seller, epoch: this.o.epoch, seq: this.seq + 1, cumulativeAmount: (this.cumulative + BigInt(announcement.amount)).toString(), unit: "credit", resource: this.o.resource,
    }, this.o.secretKey);
    const answer = proxy.call(path, voucher);
    if (answer.billed) {
      this.meter.recordCalls(1);
      this.cumulative += BigInt(announcement.amount);
      this.seq += 1;
      this.vouchers.push(voucher);
    }
    return answer;
  }
}
export { voucherPublicKey };
