// AG-030: scenarios of one-time codes (P3, ADR-48) and of a secret sold per call, against a MOCK code book and a MOCK issuer (`MockCodeBook`, `MockCodeIssuer`). The functions of the
// seller and the buyer take a `CodeBookApi`, so when BE-069 exists the same scenarios run against the real book by giving an `HttpCodeBook`; nothing else changes.
import { describe, expect, it } from "vitest";
import { CodeError, generateVoucherKeypair, httpsSource, signVoucher, type ContentRef, type ContentSource } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { MockCodeBook, MockCodeIssuer, SecretBuyer, SecretProxy, buyCode, listCode, receiveCode, serveCode, type CodeActor } from "../scenario/code.ts";

const CONTRACT = "x207-circle.near";
const acct = (n: string) => `${n}.${CONTRACT}`;
const CREDIT = 1_000_000n;
const credit = (n: number): string => (BigInt(n) * CREDIT).toString();

function setup() {
  const keys = { andi: generateVoucherKeypair(), budi: generateVoucherKeypair(), citra: generateVoucherKeypair() };
  const actor = (n: keyof typeof keys): CodeActor => ({ account: acct(n), secretKey: keys[n].secretKey, publicKey: keys[n].publicKey });
  const issuer = new MockCodeIssuer("shop.example");
  const clock = { now: 1_800_000_000 };
  const files = new Map<string, Uint8Array>();
  const book = new MockCodeBook({
    contract: CONTRACT, now: () => clock.now, publicKeys: Object.fromEntries(Object.entries(keys).map(([n, k]) => [acct(n), k.publicKey])), issuers: { "shop.example": issuer },
    fetchSource: async (ref: ContentRef) => files.get(ref.ref) ?? new Uint8Array(),
  });
  const sources: Partial<Record<ContentRef["kind"], ContentSource>> = {
    https: httpsSource({ fetch: async (url: string) => (files.has(url) ? new Response(Buffer.from(files.get(url)!), { status: 200 }) : new Response("not found", { status: 404 })) }),
  };
  const publish = (ref: string, bytes: Uint8Array) => files.set(ref, bytes);
  return { book, issuer, clock, actor, sources, publish, expiresAt: clock.now + 86_400 };
}
const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof BookError ? e.code : e instanceof CodeError ? e.code : `other: ${String(e)}`;
  }
};
const GIFT = "GIFT-7QK2-M9XD-41LP";

describe("AG-030 one-time codes: mock book and mock issuer", () => {
  it("TC-AG-030-01 a valid code is sold: the issuer is asked, the key is released sealed, the buyer opens the code, confirms, redeems it, and the book never saw the code or the salt", async () => {
    const { book, issuer, actor, sources, publish, expiresAt } = setup();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    issuer.issue(GIFT);
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "c1", expiresAt });
    expect(sold.listing.detail).not.toContain(GIFT); // the listing holds the commitment, not the code and not the plain hash
    const bought = await buyCode(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    expect(bought.status).toBe("paid_held");
    expect(bought.voucher).toBeUndefined(); // held
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/c1.bin" };
    publish(ref.ref, sold.ciphertext);
    const served = await serveCode(book, seller, bought.purchaseId, sold, ref, buyer);
    expect(served.status).toBe("key_released");
    expect(served.disputeUntil).toBe(book.at() + 3600);
    expect(issuer.asked).toEqual([GIFT]); // asked once, before the key left
    expect(served.voucher).toBeUndefined();
    const received = await receiveCode(book, buyer, bought.purchaseId, seller.publicKey, sources);
    expect(received).toMatchObject({ outcome: "confirmed", code: GIFT, status: "confirmed" });
    expect(issuer.redeem(received.code!)).toBe(true); // the buyer redeems it at the issuer
    expect((await book.get(bought.purchaseId)).voucher).toMatchObject({ payer: buyer.account, payee: seller.account, cumulativeAmount: credit(5) });
    const stored = book.dump();
    expect(stored).not.toContain(GIFT);
    expect(stored).not.toContain(Buffer.from(sold.salt).toString("hex"));
    expect(stored).not.toContain(Buffer.from(sold.key).toString("hex"));
  });

  it("TC-AG-030-02 a code that the issuer says is used is refused before the key leaves: the purchase is cancelled, the voucher is not released and nothing moves", async () => {
    const { book, issuer, actor, publish, expiresAt } = setup();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    issuer.issue(GIFT);
    issuer.markUsed(GIFT); // somebody redeemed it before
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "c2", expiresAt });
    const bought = await buyCode(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/c2.bin" };
    publish(ref.ref, sold.ciphertext);
    expect(await errCode(serveCode(book, seller, bought.purchaseId, sold, ref, buyer))).toBe("code_used");
    const after = await book.get(bought.purchaseId);
    expect(after.status).toBe("cancelled");
    expect(after.release).toBeNull(); // no key was released
    expect(after.voucher).toBeUndefined(); // and the voucher was never let go
    // a seller who skips the check cannot release the key of a checkable code either
    const again = await buyCode(book, buyer, await listCode(book, seller, { code: "OTHER-CODE-0000-AAAA", issuer: "shop.example", verifiable: true, price: credit(5), nonce: "c2b", expiresAt }), 42, { seq: 0, cumulative: "0" });
    expect(await errCode(book.notice(again.purchaseId, { sealed_key: "00".repeat(80), cipher_hash: "a".repeat(64) }, "sig"))).toBe("code_not_checked");
  });

  it("TC-AG-030-03 a code that cannot be checked is limited to 20 credit: above it the SDK refuses without a bond and nothing is posted; with a bond or a checkable issuer it passes", async () => {
    const { book, issuer, actor, expiresAt } = setup();
    const seller = actor("andi");
    issuer.issue(GIFT);
    const base = { code: GIFT, issuer: "none", verifiable: false, nonce: "c3", expiresAt };
    expect(await errCode(listCode(book, seller, { ...base, price: credit(25) }))).toBe("code_over_limit_unbonded");
    expect(await errCode(listCode(book, seller, { ...base, price: credit(20) }))).toBe("no error"); // at the limit
    expect(await errCode(listCode(book, seller, { ...base, code: "SECOND-CODE-1234-ZZ", price: credit(25), arbiter: "arbiter.near", nonce: "c3b" }))).toBe("no error"); // with a bond
    expect(await errCode(listCode(book, seller, { ...base, issuer: "shop.example", verifiable: true, code: "THIRD-CODE-5678-YY", price: credit(25), nonce: "c3c" }))).toBe("no error"); // checkable
    // the book enforces the same rule for a listing that came around the SDK
    const forged = await listCode(book, seller, { ...base, code: "FOURTH-CODE-9012-XX", price: credit(5), nonce: "c3d" });
    const over = { ...forged.listing, offer: { ...forged.listing.offer, value: credit(25) }, nonce: "c3e", detail: JSON.stringify({ ...JSON.parse(forged.listing.detail), value: credit(25) }) };
    expect(await errCode(book.postListing(over, seller.secretKey))).toBe("code_value_over_cap");
  });

  it("TC-AG-030-04 the same code listed twice with another salt is not found by hash, but the issuer stops the second sale: after the first buyer redeemed it, the check of the second says used", async () => {
    const { book, issuer, actor, sources, publish, expiresAt } = setup();
    const [seller, first, second] = [actor("andi"), actor("budi"), actor("citra")];
    issuer.issue(GIFT);
    const one = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "d1", expiresAt });
    const two = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "d2", expiresAt });
    expect(one.doc.code_commitment).not.toBe(two.doc.code_commitment); // a fresh salt: no duplicate by hash
    const p1 = await buyCode(book, first, one, 42, { seq: 0, cumulative: "0" });
    const ref1: ContentRef = { kind: "https", ref: "https://store.example.com/d1.bin" };
    publish(ref1.ref, one.ciphertext);
    await serveCode(book, seller, p1.purchaseId, one, ref1, first);
    const got = await receiveCode(book, first, p1.purchaseId, seller.publicKey, sources);
    expect(issuer.redeem(got.code!)).toBe(true);
    const p2 = await buyCode(book, second, two, 42, { seq: 0, cumulative: "0" });
    const ref2: ContentRef = { kind: "https", ref: "https://store.example.com/d2.bin" };
    publish(ref2.ref, two.ciphertext);
    expect(await errCode(serveCode(book, seller, p2.purchaseId, two, ref2, second))).toBe("code_used");
    expect((await book.get(p2.purchaseId)).status).toBe("cancelled");
  });

  it("TC-AG-030-05 the check shows the code to the issuer only with a salt that matches the commitment; a wrong code or an unknown issuer is refused, and an unknown code gives no key", async () => {
    const { book, issuer, actor, expiresAt } = setup();
    const seller = actor("andi");
    issuer.issue(GIFT);
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "e1", expiresAt });
    const salt = Buffer.from(sold.salt).toString("hex");
    expect(await errCode(book.check(sold.listingHash, seller, "WRONG-CODE-0000-AAAA", salt))).toBe("code_bad_commitment");
    expect(issuer.asked).toEqual([]); // a wrong code never reaches the issuer
    const unknown = await listCode(book, seller, { code: "NOT-ISSUED-0000-BBBB", issuer: "shop.example", verifiable: true, price: credit(5), nonce: "e2", expiresAt });
    expect(await book.check(unknown.listingHash, seller, unknown.code, Buffer.from(unknown.salt).toString("hex"))).toMatchObject({ verdict: "unknown" });
    expect(await errCode(serveCode(book, seller, (await buyCode(book, actor("budi"), unknown, 42, { seq: 0, cumulative: "0" })).purchaseId, unknown, { kind: "https", ref: "https://store.example.com/e2.bin" }, actor("budi")))).toBe("code_unknown"); // the key does not leave
    const noIssuer = { ...sold.listing, nonce: "e3", detail: JSON.stringify({ ...JSON.parse(sold.listing.detail), issuer: "nobody.example" }) };
    expect(await errCode(book.postListing(noIssuer, seller.secretKey))).toBe("code_issuer_unknown");
    expect(await errCode(book.check(sold.listingHash, seller, GIFT, salt))).toBe("no error");
  });
});

describe("AG-030 an API key sold per call through the proxy of the owner", () => {
  const API_KEY = "sk-live-9f8e7d6c5b4a39281706";
  const keys = generateVoucherKeypair();
  const provider = (failOn: Set<string>) => (apiKey: string, path: string) =>
    apiKey !== API_KEY ? { status: 401, body: "bad key" } : failOn.has(path) ? { status: 500, body: "boom" } : { status: 200, body: JSON.stringify({ path, echo: `Authorization: Bearer ${apiKey}`, answer: 42 }) };

  it("TC-AG-030-06 the bill is one unit per successful call and equals the count of the buyer: a failed call is not billed, the key is in no answer, no audit line and no voucher", () => {
    const failOn = new Set(["/v1/call-3", "/v1/call-6"]);
    const proxy = new SecretProxy({ apiKey: API_KEY, unitPrice: credit(1), buyerPublicKey: keys.publicKey, provider: provider(failOn) });
    const buyer = new SecretBuyer({ circle: CONTRACT, buyer: acct("budi"), seller: acct("andi"), epoch: 42, secretKey: keys.secretKey, unitPrice: "$1", resource: "x207:secret:demo" });
    const answers = Array.from({ length: 8 }, (_, i) => buyer.call(proxy, `/v1/call-${i + 1}`));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 502, 200, 200, 502, 200, 200]);
    expect(proxy.billed).toBe(6);
    expect(buyer.received).toBe("6"); // the count of the buyer equals the bill
    expect(proxy.registered?.cumulativeAmount).toBe(credit(6));
    expect(buyer.vouchers).toHaveLength(6);
    expect(buyer.vouchers.map((v) => v.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buyer.vouchers.at(-1)!.cumulativeAmount).toBe(credit(6));
    const everything = JSON.stringify({ answers, audit: proxy.audit, vouchers: buyer.vouchers });
    expect(everything).not.toContain(API_KEY);
    expect(answers[0]!.body).toContain("[redacted]"); // what the provider echoed back is redacted
  });

  it("TC-AG-030-07 a buyer meter refuses a bill above the price it agreed, and a proxy refuses a voucher that is not the next one", () => {
    const proxy = new SecretProxy({ apiKey: API_KEY, unitPrice: credit(2), buyerPublicKey: keys.publicKey, provider: provider(new Set()) });
    const cheap = new SecretBuyer({ circle: CONTRACT, buyer: acct("budi"), seller: acct("andi"), epoch: 42, secretKey: keys.secretKey, unitPrice: "$1", resource: "x207:secret:demo" });
    expect(() => cheap.call(proxy, "/v1/x")).toThrow(/meter_price_too_high|harga satuan/); // the proxy asks 2 credit, the buyer agreed 1
    expect(proxy.billed).toBe(0);
    const honest = new SecretProxy({ apiKey: API_KEY, unitPrice: credit(1), buyerPublicKey: keys.publicKey, provider: provider(new Set()) });
    const skipped = signVoucher({ circle: CONTRACT, payer: acct("budi"), payee: acct("andi"), epoch: 42, seq: 1, cumulativeAmount: credit(3), unit: "credit", resource: "x207:secret:demo" }, keys.secretKey);
    expect(honest.call("/v1/x", skipped)).toMatchObject({ status: 402, billed: false }); // a voucher above the next amount is not taken
    expect(honest.billed).toBe(0);
  });
});
