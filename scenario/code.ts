// Agent that sells and buys one-time-exchange codes (AG-030, pipeline P3, ADR-48) in the SDK format (SD-076): the code and salt are encrypted, the listing only carries `code_commitment`,
// the key is sealed to the buyer, the buyer's voucher is held by the book, and the issuer is checked before the key is released. The code book here is a MOCK (`MockCodeBook`) and the issuer is a mock
// (`MockCodeIssuer`); both use the `CodeBookApi` interface that the real BE-069 book will fulfil over HTTP, so the seller and buyer functions below do not change once the real book
// exists: just provide an `HttpCodeBook` that maps the five methods to backend routes. The mock error names follow `backend/docs/code-book.md` (proposal, not final).
//
// Part two: secret proxy (`SecretProxy`, BE-070) for API keys sold per call: the real key only lives in the proxy owned by the grantor, billing one unit per successful
// call, and the buyer's count (`BuyerMeter`, SD-068) must equal the bill.
import {
  CODE_DISPUTE_WINDOW_SECONDS, checkCodeDocument, codeCommitment, codeDocumentHash, codeOverLimit, codeResource, contentHash, createCodeRelease, encryptCode, fetchCiphertext, listingHash,
  signListing, signVoucher, verifyCodeDelivery, verifyListingSignature, verifyVoucher, voucherPublicKey,
  type CodeCheck, type CodeDocument, type CodeIssuer, type ContentRef, type ContentSource, type Listing, type UnsignedVoucher, type Voucher, type VoucherSecretKey,
} from "@x207/core";
import { BuyerMeter } from "@x207/scheme";
import { BookError, signJsonNotice, type InvoiceActor } from "./invoice-book.ts";
import { LicenseBook, type PurchaseState } from "./license.ts";

export type CodeActor = InvoiceActor & { publicKey: string };

/** Mock issuer: stores the issued codes; `markUsed` marks a code as used (redeemed elsewhere). */
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
  /** The buyer redeems the code at the issuer: succeeds once. */
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

/** State of one code purchase: the same shape as a license purchase (BE-056); a code is always exclusive. */
export type CodePurchase = PurchaseState;

/** What the seller and buyer use from the code book; the real book (BE-069) maps this to HTTP routes. */
export interface CodeBookApi {
  readonly contract: string;
  at(): number;
  postListing(listing: Listing, secretKey: VoucherSecretKey): Promise<unknown>;
  purchase(hash: string, voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Promise<CodePurchase>;
  get(id: string): Promise<CodePurchase>;
  notice(id: string, notice: any, signature: string): Promise<CodePurchase>;
  /**
   * The seller shows the code once so the issuer is checked (`POST /listings/{hash}/code-check`); the book stores only the verdict and its time and answers 200 with the verdict: `used`
   * cancels the purchase and the listing. Throws `code_issuer_unknown`, `code_issuer_unavailable`, `code_not_verifiable`, or `code_bad_commitment`.
   */
  check(listingHash: string, seller: CodeActor, code: string, salt: string): Promise<{ verdict: CodeCheck; checkedAt: number }>;
}

type Held = CodePurchase & { ciphertext?: Uint8Array; voucherHeld?: Voucher; price: string }

/** Mock code book, in memory. It does not store the code, salt, or file key; only the issuer verdict and its time. */
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
  /** Everything the book stores, to check that the code and salt are absent. */
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
    // like the real book (ADR-48 points 6 and 7): no arbiter, and a cap by kind (20 credit unchecked, 100 credit checkable) that nothing lifts
    if (detail.arbiter !== undefined && detail.arbiter !== null) throw new BookError(400, "arbiter_not_supported", "no bond is locked for a code sale");
    if (codeOverLimit({ value: listing.offer.value, verifiable })) throw new BookError(400, "code_over_limit_unbonded", "the value is above the cap of its kind");
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
      release: null, releaseSignature: null, disputeUntil: null, exclusive: true, needsBond: false, autoConfirmed: false, voucherHeld: signed, price: entry.listing.offer.value,
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
    return { ...rest, exclusive: true, needsBond: false, autoConfirmed: false, ...(p.status === "confirmed" && voucherHeld ? { voucher: voucherHeld } : {}) };
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

  async check(hash: string, _seller: CodeActor, code: string, salt: string): Promise<{ verdict: CodeCheck; checkedAt: number }> {
    const entry = this.listings.get(hash);
    if (!entry) throw new BookError(404, "listing_not_found", hash);
    const commitment: string = entry.detail.code_commitment;
    let ok = false;
    try {
      ok = codeCommitment(code, Uint8Array.from(Buffer.from(salt, "hex"))) === commitment;
    } catch {
      ok = false;
    }
    if (!ok) throw new BookError(400, "code_bad_commitment", "code and salt do not match the commitment");
    if (!entry.detail.verifiable) throw new BookError(400, "code_not_verifiable", "the issuer has no check");
    const issuer = this.issuers[entry.detail.issuer];
    if (!issuer) throw new BookError(400, "code_issuer_unknown", entry.detail.issuer);
    const verdict = await issuer.checkCode(code); // the code goes to the issuer only; the book keeps the verdict
    const record = { verdict, checkedAt: this.now() };
    this.verdicts.set(commitment, record);
    if (verdict === "used") {
      // a used code cannot be sold: every open purchase of it is cancelled and its voucher is let go
      for (const p of this.purchases.values()) if (p.contentHash === commitment && p.status !== "confirmed") { p.status = "cancelled"; delete p.voucherHeld; }
    }
    return record; // like the real book: the answer is 200 with the verdict; the key release is what refuses a verdict that is not valid
  }
}

/** Real code book (BE-069) over HTTP: the same BE-056 purchase routes, plus `POST /listings/{hash}/code-check`. */
export class HttpCodeBook extends LicenseBook implements CodeBookApi {
  /** `POST /listings/{hash}/takedown`: a claimant signs `{circle, listing_hash, claim, evidence_hash}`. A buyer of the listing is refused (`takedown_invalid`, B7-C1). */
  takedown(hash: string, claimant: CodeActor, claim: string, evidenceHash = ""): Promise<unknown> {
    const message = { circle: this.contract, listing_hash: hash, claim, evidence_hash: evidenceHash };
    return this.call("POST", `/listings/${hash}/takedown`, { claim, evidence_hash: evidenceHash, signature: signJsonNotice(this.contract, message, claimant.secretKey) });
  }
  /** A buyer's notice `disputed` with reason `other` and no proof: a complaint, or `{notDelivered: true}` when the backend finds the signed ciphertext missing (B7-C2). */
  async complain(id: string, buyer: CodeActor): Promise<CodePurchase & { complaint?: boolean; notDelivered?: boolean }> {
    const notice = { circle: this.contract, purchase_id: id, actor: buyer.account, action: "disputed", at: this.at(), reason: "other", proof: null };
    return (await this.call("POST", `/purchases/${id}`, { notice, signature: signJsonNotice(this.contract, notice, buyer.secretKey) })) as CodePurchase & { complaint?: boolean; notDelivered?: boolean };
  }
  async check(hash: string, seller: CodeActor, code: string, salt: string): Promise<{ verdict: CodeCheck; checkedAt: number }> {
    const notice = { circle: this.contract, listing_hash: hash, actor: seller.account, action: "check", at: this.at() };
    const answer = await this.call("POST", `/listings/${hash}/code-check`, { notice, signature: signJsonNotice(this.contract, notice, seller.secretKey), code, salt });
    return { verdict: answer.verdict, checkedAt: answer.checkedAt };
  }
}

export type SoldCode = { listing: Listing; listingHash: string; doc: Required<CodeDocument>; docHash: string; code: string; salt: Uint8Array; ciphertext: Uint8Array; key: Uint8Array }

/** The seller prepares the code: salt, encryption, document (the 20 credit limit is enforced by the SDK), and signed listing. Throws `CodeError` from the SDK before anything is sent. */
export async function listCode(book: CodeBookApi, seller: CodeActor, o: {
  code: string; issuer: string; verifiable: boolean; price: string; nonce: string; expiresAt: number; assetType?: string
}): Promise<SoldCode> {
  const { ciphertext, key, code_commitment, salt } = encryptCode(o.code);
  const doc = checkCodeDocument({ circle: book.contract, seller: seller.account, code_commitment, issuer: o.issuer, value: o.price, verifiable: o.verifiable, arbiter: null, nonce: o.nonce });
  const docHash = codeDocumentHash(doc);
  const listing: Listing = {
    circle: book.contract, account: seller.account,
    offer: { asset_type: o.assetType ?? "code:gift", asset_class: "D", quantity: 1, value: o.price },
    want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: o.price },
    terms: "one-time code", detail: JSON.stringify({ kind: "code", code_doc: docHash, code_commitment, issuer: o.issuer, value: o.price, verifiable: o.verifiable, nonce: o.nonce }),
    expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `code-${o.nonce}`,
  };
  await book.postListing(listing, seller.secretKey);
  return { listing, listingHash: listingHash(listing), doc, docHash, code: o.code, salt, ciphertext, key };
}

/** The buyer pays with a voucher that the book holds. */
export function buyCode(book: CodeBookApi, buyer: InvoiceActor, sold: SoldCode, epoch: number, state: { seq: number; cumulative: string }): Promise<CodePurchase> {
  const voucher: UnsignedVoucher = {
    circle: book.contract, payer: buyer.account, payee: sold.listing.account, epoch, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulative) + BigInt(sold.listing.offer.value)).toString(), unit: "credit", resource: codeResource(sold.docHash),
  };
  return book.purchase(sold.listingHash, voucher, buyer.secretKey);
}

/** The seller records the ciphertext, shows the code to the book for the issuer check (if it can be checked), then releases the sealed key. */
export async function serveCode(book: CodeBookApi, seller: CodeActor, id: string, sold: SoldCode, source: ContentRef, buyer: CodeActor): Promise<CodePurchase> {
  const posted = { circle: book.contract, purchase_id: id, actor: seller.account, action: "cipher_posted", at: book.at(), source, cipher_hash: contentHash(sold.ciphertext) };
  await book.notice(id, posted, signJsonNotice(book.contract, posted, seller.secretKey));
  if (sold.doc.verifiable) {
    const { verdict } = await book.check(sold.listingHash, seller, sold.code, Buffer.from(sold.salt).toString("hex"));
    // the book already cancelled the sale on `used`; the key stays with the seller whatever the verdict that is not valid
    if (verdict !== "valid") throw new BookError(409, `code_${verdict}`, "the issuer did not say valid: the key is not released");
  }
  const { release, signature } = createCodeRelease({
    doc: sold.doc, code: sold.code, salt: sold.salt, buyer: buyer.account, buyerPublicKey: buyer.publicKey, purchase_id: id, ciphertext: sold.ciphertext, contentKey: sold.key, at: book.at(),
    sellerSecretKey: seller.secretKey as string,
  });
  return book.notice(id, release, signature);
}

export type ReceivedCode = { outcome: "confirmed" | "refused" | "waiting"; code?: string; reason?: string; status?: CodePurchase["status"] }

/** Tries the code at the issuer and says whether it worked: the buyer agent redeems (or at least asks the issuer) before it pays. */
export type CodeRedeemer = (code: string) => Promise<boolean>;

/**
 * The buyer downloads, checks the release and the content against the code document of the listing it looked at (B6-F4, `doc`), and then (B6-F3):
 *  - with `redeem`: tries the code at the issuer. Worked: `confirmed` (the voucher goes to the seller). Did not: `refused`, nothing is confirmed, and the one hour window stays open
 *    for a complaint or for a proof;
 *  - without `redeem`: `waiting`, the code is returned and nothing is confirmed; silence confirms after the window (the buyer keeps the window to try the code by other means).
 * The code is only in the hands of the buyer.
 */
export async function receiveCode(
  book: CodeBookApi, buyer: CodeActor, id: string, sellerPublicKey: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>, o: { doc: CodeDocument; redeem?: CodeRedeemer },
): Promise<ReceivedCode> {
  const view = await book.get(id);
  if (view.source === null || view.cipherHash === null || view.release === null || view.releaseSignature === null) return { outcome: "refused", reason: "the seller has not released the key" };
  let ciphertext: Uint8Array;
  try {
    ciphertext = await fetchCiphertext(view.source, view.cipherHash, sources);
  } catch (e) {
    return { outcome: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
  const verdict = verifyCodeDelivery({ ciphertext, release: view.release, signature: view.releaseSignature, sellerPublicKey, buyerSecretKey: buyer.secretKey as string, purchaseId: id, doc: o.doc });
  if (!verdict.ok) return { outcome: "refused", reason: verdict.reason };
  if (o.redeem === undefined) return { outcome: "waiting", code: verdict.code!, status: view.status };
  if (!(await o.redeem(verdict.code!))) return { outcome: "refused", reason: "the issuer did not accept the code: not confirmed", status: view.status };
  const notice = { circle: book.contract, purchase_id: id, actor: buyer.account, action: "confirmed", at: book.at(), reason: null, proof: null };
  const after = await book.notice(id, notice, signJsonNotice(book.contract, notice, buyer.secretKey));
  return { outcome: "confirmed", code: verdict.code!, status: after.status };
}

// ---- secret proxy (BE-070): an API key sold per call, the key stays in the proxy of the owner ------------------------------------------------------------------------------

export type ProviderResponse = { status: number; body: string };
/**
 * Secret proxy owned by the grantor (self-hosted mode): forwards calls to the provider with the real key, strips the key from the response, and bills one unit per successful
 * call. A cumulative voucher sent along with a new call is recorded if the provider answers below 400; failed calls are not billed.
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
  /** The 402 announcement for one call: unit `call`, amount 1. */
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

/** The buyer pays per call: own count (`BuyerMeter`), a cumulative voucher above the registered one, and only successful calls are counted. */
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
