// AG-027: agents that sell and buy licenses of content (SD-070, ADR-46) through the real purchase routes of the backend (BE-056), in process: in-memory database, real voucher keys, a
// fake "internet" that serves the ciphertext. The key of the file never reaches the backend, and the voucher of the buyer is in no answer until the purchase is confirmed or refuted.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash, httpsSource, type ContentRef, type ContentSource } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { LicenseBook, buyLicense, falseDispute, listLicense, receiveLicense, serveLicense, type LicenseActor } from "../scenario/license.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct } from "./market.ts";

const load = (path: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}${path}`).href);
const CREDIT = 1_000_000n;
const credit = (n: number): string => (BigInt(n) * CREDIT).toString();
const text = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!BACKEND_AVAILABLE)("AG-027 licenses of content: fair exchange with encryption", () => {
  let market: any;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  /** What the "internet" serves: https://store.example.com/<path> -> bytes. */
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
  /** The same internet for the buyer's SDK: an https source on a fake fetch. */
  const sources: Partial<Record<ContentRef["kind"], ContentSource>> = {
    https: httpsSource({ fetch: async (url: string) => {
      const bytes = files.get(url.replace("https://", ""));
      return bytes ? new Response(Buffer.from(bytes), { status: 200 }) : new Response("not found", { status: 404 });
    } }),
  };

  async function start() {
    files.clear();
    const { startMarket, openEpoch } = await load("test/marketplace/helpers.ts");
    market = await startMarket(["andi", "budi", "citra", "dewi"], [], undefined, { sourceFetch: { resolver, transport } });
    openEpoch(market, 42);
    const actor = (name: string): LicenseActor => ({ account: acct(name), secretKey: market.keys[name].secretKey, publicKey: market.keys[name].publicKey });
    const book = new LicenseBook(market.srv.url, CIRCLE_ID, CONTRACT, () => Math.floor(market.clock.now / 1000));
    const expiresAt = Math.floor(market.clock.now / 1000) + 86_400;
    const publish = (ref: string, bytes: Uint8Array) => files.set(ref.replace("https://", ""), bytes);
    return { book, actor, expiresAt, publish };
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof BookError ? e.code : `other: ${String(e)}`;
    }
  };

  it("TC-AG-027-01 a dataset is sold with a matching hash: the key is released sealed, the buyer opens it, confirms, and only then the voucher is in the answer", async () => {
    const { book, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    const plain = text("id,name\n1,alpha\n2,beta\n3,gamma\n");
    const sold = await listLicense(book, seller, { plain, assetType: "data:dataset", licenseId: "commercial", nonce: "ds1", price: credit(50), expiresAt });
    const bought = await buyLicense(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    expect(bought.status).toBe("paid_held");
    expect((bought as any).voucher).toBeUndefined(); // held
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/ds1.bin" };
    publish(ref.ref, sold.ciphertext);
    const served = await serveLicense(book, seller, bought.purchaseId, sold, ref, buyer);
    expect(served.status).toBe("key_released");
    expect(served.cipherHash).toBe(contentHash(sold.ciphertext));
    expect(JSON.stringify(served)).not.toContain(Buffer.from(sold.key).toString("hex")); // the backend never sees the key of the file
    expect((served as any).voucher).toBeUndefined();
    const received = await receiveLicense(book, buyer, bought.purchaseId, seller.publicKey, sources);
    expect(received).toMatchObject({ outcome: "confirmed", status: "confirmed" });
    expect(Buffer.from(received.content!).equals(Buffer.from(plain))).toBe(true);
    const after = await book.get(bought.purchaseId);
    expect(after.voucher).toMatchObject({ payer: buyer.account, payee: seller.account, cumulativeAmount: credit(50) });
  });

  it("TC-AG-027-02 a template is sold and the buyer is silent: after the window of 72 hours the purchase is confirmed by itself and the voucher is released", async () => {
    const { book, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("citra")];
    const sold = await listLicense(book, seller, { plain: text("<svg>template</svg>"), assetType: "design:template", licenseId: "commercial", nonce: "tp1", price: credit(20), expiresAt });
    const bought = await buyLicense(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/tp1.bin" };
    publish(ref.ref, sold.ciphertext);
    await serveLicense(book, seller, bought.purchaseId, sold, ref, buyer);
    expect((await book.get(bought.purchaseId)).status).toBe("key_released");
    market.clock.now += 73 * 3600 * 1000;
    const after = await book.get(bought.purchaseId);
    expect(after).toMatchObject({ status: "confirmed", autoConfirmed: true });
    expect(after.voucher).toBeDefined();
  });

  it("TC-AG-027-03 a wrong file is refused without payment: the buyer's SDK makes the proof, the backend checks it by itself, and the voucher never leaves", async () => {
    const { book, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("budi")];
    // the listing says the hash of the dataset; the seller encrypts another file
    const sold = await listLicense(book, seller, { plain: text("not the dataset at all"), claimedPlain: text("id,name\n1,alpha\n"), assetType: "data:dataset", licenseId: "commercial", nonce: "bad1", price: credit(50), expiresAt });
    const bought = await buyLicense(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/bad1.bin" };
    publish(ref.ref, sold.ciphertext);
    await serveLicense(book, seller, bought.purchaseId, sold, ref, buyer);
    const received = await receiveLicense(book, buyer, bought.purchaseId, seller.publicKey, sources);
    expect(received).toMatchObject({ outcome: "disputed", reason: "content_mismatch" });
    expect(received.proof).toBeDefined();
    const after = await book.get(bought.purchaseId);
    expect(after.status).toBe("disputed");
    expect(after.voucher).toBeUndefined();
  });

  it("TC-AG-027-04 a second exclusive license of the same content is refused; the first is bought; another content is free", async () => {
    const { book, actor, expiresAt } = await start();
    const seller = actor("andi");
    const sold = await listLicense(book, seller, { plain: text("the only copy"), assetType: "data:dataset", licenseId: "commercial", exclusive: true, nonce: "ex1", price: credit(100), expiresAt });
    const first = await buyLicense(book, actor("budi"), sold, 42, { seq: 0, cumulative: "0" });
    expect(first).toMatchObject({ status: "paid_held", exclusive: true, needsBond: true });
    expect(await code(buyLicense(book, actor("citra"), sold, 42, { seq: 0, cumulative: "0" }))).toBe("exclusive_taken");
    const other = await listLicense(book, seller, { plain: text("another content"), assetType: "data:dataset", licenseId: "commercial", exclusive: true, nonce: "ex2", price: credit(100), expiresAt });
    expect((await buyLicense(book, actor("citra"), other, 42, { seq: 0, cumulative: "0" })).status).toBe("paid_held");
  });

  it("TC-AG-027-05 a false dispute fails: the buyer asks for a refund of a correct file with a proof of its own, the proof is refuted and the seller gets the voucher", async () => {
    const { book, actor, expiresAt, publish } = await start();
    const [seller, buyer] = [actor("andi"), actor("dewi")];
    const sold = await listLicense(book, seller, { plain: text("id,name\n1,alpha\n2,beta\n"), assetType: "data:dataset", licenseId: "commercial", nonce: "fd1", price: credit(50), expiresAt });
    const bought = await buyLicense(book, buyer, sold, 42, { seq: 0, cumulative: "0" });
    const ref: ContentRef = { kind: "https", ref: "https://store.example.com/fd1.bin" };
    publish(ref.ref, sold.ciphertext);
    await serveLicense(book, seller, bought.purchaseId, sold, ref, buyer);
    const after = await falseDispute(book, buyer, bought.purchaseId);
    expect(after.status).toBe("refuted");
    expect((await book.get(bought.purchaseId)).voucher).toMatchObject({ payer: buyer.account, payee: seller.account });
    // and a source that serves other bytes is not cheating by the seller: the buyer's SDK refuses it and makes no proof
    const second = await listLicense(book, seller, { plain: text("rows"), assetType: "data:dataset", licenseId: "commercial", nonce: "fd2", price: credit(10), expiresAt });
    const b2 = await buyLicense(book, actor("budi"), second, 42, { seq: 0, cumulative: "0" });
    const ref2: ContentRef = { kind: "https", ref: "https://store.example.com/fd2.bin" };
    publish(ref2.ref, second.ciphertext);
    await serveLicense(book, seller, b2.purchaseId, second, ref2, actor("budi"));
    publish(ref2.ref, text("tampered by the host"));
    const refused = await receiveLicense(book, actor("budi"), b2.purchaseId, seller.publicKey, sources);
    expect(refused.outcome).toBe("refused");
    expect(refused.reason).toMatch(/cipher_hash_mismatch/);
    expect((await book.get(b2.purchaseId)).status).toBe("key_released");
  });
});
