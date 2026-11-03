// AG-030 against the real code book of the backend (BE-069), in process: in-memory database, real voucher keys, the mock issuer of the backend, a fake "internet" for the ciphertext.
// The same functions as in code.test.ts (`listCode`, `buyCode`, `serveCode`, `receiveCode`) run here with `HttpCodeBook` in place of `MockCodeBook`.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodeError, httpsSource, type ContentRef, type ContentSource } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { HttpCodeBook, buyCode, listCode, receiveCode, serveCode, type CodeActor } from "../scenario/code.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct, startMarket } from "./backend-fixtures.ts";

const credit = (n: number): string => (BigInt(n) * 1_000_000n).toString();
/** The issuer of the backend only checks and marks; the buyer agent redeems: ask, and mark used when valid. */
const redeemAt = async (issuer: any, c: string): Promise<boolean> => ((await issuer.checkCode(c)) === "valid" ? (issuer.markUsed(c), true) : false);
const GIFT = "GIFT-7QK2-M9XD-41LP";

describe.skipIf(!BACKEND_AVAILABLE)("AG-030 one-time codes against the real book (BE-069)", () => {
  let market: any;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  const files = new Map<string, Uint8Array>();
  const transport = async ({ host, path, method, onChunk }: any) => {
    const bytes = files.get(`${host}${path}`);
    if (!bytes) return { status: 404, body: Buffer.alloc(0), truncated: false };
    if (method === "HEAD") return { status: 200, body: Buffer.alloc(0), truncated: false };
    if (onChunk) {
      for (let i = 0; i < bytes.length; i += 16_384) onChunk(Buffer.from(bytes.subarray(i, i + 16_384)));
      return { status: 200, body: Buffer.alloc(0), truncated: false };
    }
    return { status: 200, body: Buffer.from(bytes), truncated: false };
  };
  const resolver = async () => ["93.184.216.34"];
  const sources: Partial<Record<ContentRef["kind"], ContentSource>> = {
    https: httpsSource({ fetch: async (url: string) => (files.has(url.replace("https://", "")) ? new Response(Buffer.from(files.get(url.replace("https://", ""))!), { status: 200 }) : new Response("not found", { status: 404 })) }),
  };

  async function start() {
    files.clear();
    const { MockCodeIssuer } = await import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}src/marketplace/code-issuers.ts`).href);
    const issuer = new MockCodeIssuer();
    market = await startMarket(["andi", "budi", "citra"], { sourceFetch: { resolver, transport }, codeIssuers: { "shop.example": issuer } });
    const actor = (name: string): CodeActor => ({ account: acct(name), secretKey: market.keys[name].secretKey, publicKey: market.keys[name].publicKey });
    const book = new HttpCodeBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const expiresAt = Math.floor(market.clock.now / 1000) + 86_400;
    const publish = (ref: string, bytes: Uint8Array) => files.set(ref.replace("https://", ""), bytes);
    return { book, issuer, actor, expiresAt, publish };
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof BookError ? e.code : e instanceof CodeError ? e.code : `other: ${String(e)}`;
    }
  };
  /** Everything in every table of the database as one text: the code, the salt and the key of the file must not be in it. */
  const wholeDatabase = (): string => {
    const tables = market.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t: any) => t.name as string);
    return JSON.stringify(tables.map((t: string) => market.db.prepare(`SELECT * FROM "${t}"`).all()), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  };
  const ref = (name: string): ContentRef => ({ kind: "https", ref: `https://store.example.com/${name}.bin` });

  it("TC-AG-030-08 a valid code is sold through the real book: held voucher, the issuer asked once before the key leaves, the buyer opens and confirms, and the code, the salt and the key are in no table", async () => {
    const { book, issuer, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    issuer.issue(GIFT);
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "r1", expiresAt });
    const bought = await buyCode(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    expect(bought.status).toBe("paid_held");
    expect((bought as any).voucher).toBeUndefined();
    publish(ref("r1").ref, sold.ciphertext);
    const served = await serveCode(book, seller, bought.purchaseId, sold, ref("r1"), buyer);
    expect(served.status).toBe("key_released");
    expect(issuer.calls).toBe(1);
    const received = await receiveCode(book, buyer, bought.purchaseId, seller.publicKey, sources, { doc: sold.doc, redeem: async (c) => redeemAt(issuer, c) });
    expect(received).toMatchObject({ outcome: "confirmed", code: GIFT, status: "confirmed" });
    expect((await book.get(bought.purchaseId)).voucher).toMatchObject({ payer: buyer.account, payee: seller.account, cumulativeAmount: credit(5) });
    const stored = wholeDatabase();
    expect(stored).not.toContain(GIFT);
    expect(stored).not.toContain(Buffer.from(sold.salt).toString("hex"));
    expect(stored).not.toContain(Buffer.from(sold.key).toString("hex"));
  });

  it("TC-AG-030-09 a used code: the check says code_used, the purchase and the listing are cancelled, no key is released and the voucher never reaches the seller", async () => {
    const { book, issuer, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    issuer.issue(GIFT).markUsed(GIFT);
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "r2", expiresAt });
    const bought = await buyCode(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    publish(ref("r2").ref, sold.ciphertext);
    expect(await code(serveCode(book, seller, bought.purchaseId, sold, ref("r2"), buyer))).toBe("code_used");
    const after = await book.get(bought.purchaseId);
    expect(after.status).toBe("cancelled");
    expect(after.release).toBeNull();
    expect((after as any).voucher).toBeUndefined();
    expect(await code(buyCode(book, actor("citra"), sold, 42, { seq: 0, cumulative: "0" }))).not.toBe("no error"); // the listing is closed for a new buyer
  });

  it("TC-AG-030-10 the key is not released without a fresh check, and an issuer that is down is a 503 that can be tried again", async () => {
    const { book, issuer, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    issuer.issue(GIFT);
    const sold = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "r3", expiresAt });
    const bought = await buyCode(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    publish(ref("r3").ref, sold.ciphertext);
    issuer.unavailable = true;
    expect(await code(serveCode(book, seller, bought.purchaseId, sold, ref("r3"), buyer))).toBe("code_issuer_unavailable");
    issuer.unavailable = false;
    const posted = await book.get(bought.purchaseId);
    expect(posted.status).toBe("cipher_posted"); // nothing was decided: the purchase waits
    await book.check(sold.listingHash, seller, sold.code, Buffer.from(sold.salt).toString("hex"));
    market.clock.now += 601_000; // the verdict is good for 600 seconds
    expect(await code(serveCode2(book, seller, bought.purchaseId, sold, buyer))).toBe("code_not_checked");
  });

  it("TC-AG-030-11 a code above its cap is refused by the SDK before anything is posted (20 credit unchecked, 100 checkable), an arbiter is refused by the real book, and the same code under the cap is listed", async () => {
    const { book, issuer, actor, expiresAt } = await start();
    const seller = actor("andi");
    issuer.issue(GIFT);
    const base = { code: GIFT, issuer: "none", verifiable: false, nonce: "r4", expiresAt };
    expect(await code(listCode(book, seller, { ...base, price: credit(25) }))).toBe("code_over_limit_unbonded");
    expect(await code(listCode(book, seller, { ...base, price: credit(20) }))).toBe("no error");
    expect(await code(listCode(book, seller, { ...base, code: "THIRD-CODE-5678-YY", issuer: "shop.example", verifiable: true, price: credit(25), nonce: "r4c" }))).toBe("no error"); // checkable: capped at 100
    expect(await code(listCode(book, seller, { ...base, code: "SECOND-CODE-1234-ZZ", issuer: "shop.example", verifiable: true, price: credit(101), nonce: "r4b" }))).toBe("code_over_limit_unbonded");
    // a listing that goes around the SDK: the real book refuses it with the same name
    const forged = await listCode(book, seller, { ...base, code: "FOURTH-CODE-9012-XX", price: credit(5), nonce: "r4d" });
    const over = { ...forged.listing, offer: { ...forged.listing.offer, value: credit(25) }, nonce: "r4e" };
    expect(await code(book.postListing(over, seller.secretKey))).toBe("code_over_limit_unbonded");
    const withArbiter = { ...forged.listing, nonce: "r4f", detail: JSON.stringify({ ...JSON.parse(forged.listing.detail), arbiter: "arbiter.near" }) };
    expect(await code(book.postListing(withArbiter, seller.secretKey))).toBe("arbiter_not_supported");
  });

  it("TC-AG-030-12 the same code listed again with another salt is not found by hash, and the issuer stops the second sale once the first buyer redeemed it", async () => {
    const { book, issuer, actor, expiresAt, publish } = await start();
    const [seller, first, second] = [actor("andi"), actor("budi"), actor("citra")];
    issuer.issue(GIFT);
    const one = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "r5", expiresAt });
    const two = await listCode(book, seller, { code: GIFT, issuer: "shop.example", verifiable: true, price: credit(5), nonce: "r5b", expiresAt });
    expect(one.doc.code_commitment).not.toBe(two.doc.code_commitment);
    const p1 = await buyCode(book, first, one, 42, { seq: 0, cumulative: "0" });
    publish(ref("r5").ref, one.ciphertext);
    await serveCode(book, seller, p1.purchaseId, one, ref("r5"), first);
    const got = await receiveCode(book, first, p1.purchaseId, seller.publicKey, sources, { doc: one.doc, redeem: async (c) => redeemAt(issuer, c) });
    expect(got.outcome).toBe("confirmed");
    const p2 = await buyCode(book, second, two, 42, { seq: 0, cumulative: "0" });
    publish(ref("r5b").ref, two.ciphertext);
    expect(await code(serveCode(book, seller, p2.purchaseId, two, ref("r5b"), second))).toBe("code_used");
    expect((await book.get(p2.purchaseId)).status).toBe("cancelled");
  });
});

/** The seller tries to release the key again without asking the issuer: the book wants a fresh verdict. */
async function serveCode2(book: HttpCodeBook, seller: CodeActor, id: string, sold: Awaited<ReturnType<typeof listCode>>, buyer: CodeActor) {
  const { createCodeRelease } = await import("@x207/core");
  const { release, signature } = createCodeRelease({
    doc: sold.doc, code: sold.code, salt: sold.salt, buyer: buyer.account, buyerPublicKey: buyer.publicKey, purchase_id: id, ciphertext: sold.ciphertext, contentKey: sold.key, at: book.at(), sellerSecretKey: seller.secretKey as string,
  });
  return book.notice(id, release, signature);
}
