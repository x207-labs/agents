// AG-031 against the real transfer ledger of the backend (BE-074), in process, with the format of the SDK (SD-077): in-memory database, real voucher keys, the proofs of the backend behind its
// SSRF guard, and a fake "internet" for the platforms (DNS over HTTPS, the registry RDAP and the trade offer API of Steam). Nothing leaves the process.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFER_WINDOW_SECONDS, TransferError } from "@x207/core";
import { BookError } from "../scenario/invoice-book.ts";
import { HttpTransferBook, buyTransfer, buyerTxt, postTransfer, prepareTransfer, releasePair, releasedVoucher, waitForProof, type PairState, type TransferActor } from "../scenario/transfer.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct, startMarket } from "./backend-fixtures.ts";

const credit = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const DOMAIN = "agent-shop.com";
const STEAM_KEY = "STEAM-KEY-AGENTS-TEST";

describe.skipIf(!BACKEND_AVAILABLE)("AG-031 transfer through the platform against the real ledger (BE-074)", () => {
  let market: any;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  // the platforms
  const dns = new Map<string, string[]>();
  const rdap = new Map<string, unknown>();
  const steam = new Map<string, unknown>();
  const asked: string[] = [];
  const reply = (status: number, body: unknown) => ({ status, body: Buffer.from(JSON.stringify(body)), truncated: false });
  const transport = async ({ host, path }: { host: string; path: string }) => {
    asked.push(`${host}${path.split("?")[0]}`);
    if (host === "dns.google") {
      const name = new URL(`https://x${path}`).searchParams.get("name") ?? "";
      const records = dns.get(name);
      return records === undefined ? reply(200, { Status: 3 }) : reply(200, { Status: 0, Answer: records.map((r) => ({ name, type: 16, TTL: 60, data: `"${r}"` })) });
    }
    if (host === "rdap.verisign.com") return rdap.has(path.split("/").pop() ?? "") ? reply(200, rdap.get(path.split("/").pop() ?? "")) : reply(404, null);
    if (host === "api.steampowered.com") {
      const id = new URL(`https://x${path}`).searchParams.get("tradeofferid") ?? "";
      return reply(200, { response: steam.has(id) ? { offer: steam.get(id) } : {} });
    }
    return { status: 404, body: Buffer.alloc(0), truncated: false };
  };
  const resolver = async () => ["93.184.216.34"];

  async function start() {
    dns.clear(); rdap.clear(); steam.clear(); asked.length = 0;
    const { DnsTxtProof, TradeApiProof } = await import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}src/marketplace/transfer-proofs.ts`).href);
    market = await startMarket(["andi", "budi", "citra"], {
      dnsTxt: new DnsTxtProof({ resolver, transport }), tradeApi: new TradeApiProof({ apiKey: STEAM_KEY, baseUrl: "https://api.steampowered.com", resolver, transport }), proofMinSeconds: 0,
    });
    const actor = (name: string): TransferActor => ({ account: acct(name), secretKey: market.keys[name].secretKey });
    const now = () => Math.floor(market.clock.now / 1000);
    const book = new HttpTransferBook(market.srv.url, CIRCLE_ID, CONTRACT, now);
    return { book, actor, now, expiresAt: now() + 30 * 86_400, pair: (): PairState => ({ seq: 0, cumulative: "0" }), wait: async () => { market.clock.now += 1000; } };
  }
  const error = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof BookError ? e.code : e instanceof TransferError ? e.code : `other: ${String(e)}`;
    }
  };

  it("TC-AG-031-01 a domain: the seller proves control before the listing, the voucher is held until the buyer controls the domain and the registry is settled, then it goes to the seller", async () => {
    const { book, actor, expiresAt, pair, wait } = await start();
    const [andi, budi, citra] = [actor("andi"), actor("budi"), actor("citra")];
    const sale = prepareTransfer(book, andi, { platform: "domain", ref: DOMAIN, price: credit(40), estimateSeconds: 3600, nonce: "dom1", expiresAt });
    expect(sale.sellerTxt).toBe(`x207-sell=${sale.listingHash}`);
    // without the TXT of the seller the book refuses the listing
    expect(await error(postTransfer(book, andi, sale))).toBe("transfer_seller_unproven");
    dns.set(DOMAIN, [sale.sellerTxt!]);
    await postTransfer(book, andi, sale);

    const p = pair();
    const bought = await buyTransfer(book, budi, sale, 42, p);
    expect([bought.status, bought.platform, bought.proofMethod]).toEqual(["paid_held", "domain", "dns_txt"]);
    expect(bought.instructions).toEqual({ setTxtAfterTransfer: expect.stringMatching(new RegExp(`^x207-own=${bought.transferId}-[0-9a-f]{32}$`)), on: DOMAIN });
    expect(bought.windowUntil - book.at()).toBe(TRANSFER_WINDOW_SECONDS.domain);
    expect(bought.voucher).toBeUndefined();

    // the registrar has not moved the domain and the buyer has no TXT: pending, and the book says what it wants
    const early = await book.proof(bought.transferId);
    expect(early).toMatchObject({ outcome: "pending" });
    // since UM-096 the answer names the TXT record and does not show its value
    expect((early as unknown as { missing: { want: string } }).missing.want).toMatch(/x207-own TXT record/);
    expect(JSON.stringify(early)).not.toContain(buyerTxt(bought));
    // the registrar moves the domain; the buyer sets its TXT, but the registry still says the transfer is pending
    dns.set(DOMAIN, [sale.sellerTxt!, buyerTxt(bought)]);
    rdap.set(DOMAIN, { ldhName: DOMAIN, status: ["pending transfer"] });
    expect((await book.proof(bought.transferId)).outcome).toBe("pending");
    // the registry settles
    rdap.set(DOMAIN, { ldhName: DOMAIN, status: ["active"] });
    const done = await waitForProof(book, bought.transferId, { tries: 3, wait });
    expect(done.outcome).toBe("confirmed");
    const { voucher } = releasedVoucher((done as { transfer: any }).transfer);
    expect(voucher).toMatchObject({ payer: budi.account, payee: andi.account, cumulativeAmount: credit(40), seq: 1 });
    // the thing is sold: nobody else can buy it
    expect(await error(buyTransfer(book, citra, sale, 42, pair()))).toBe("listing_not_open");
  });

  it("TC-AG-031-02 a game item: nothing is paid until the trade offer is accepted, goes to the buyer, carries the item, and its hold is over", async () => {
    const { book, actor, now, expiresAt, pair, wait } = await start();
    const [andi, budi] = [actor("andi"), actor("budi")];
    const sale = prepareTransfer(book, andi, { platform: "game_item", ref: "730:1000000001", price: credit(12), estimateSeconds: 900, nonce: "gi1", expiresAt });
    expect(sale.sellerTxt).toBeNull();
    await postTransfer(book, andi, sale);
    // a game item names the Steam account of the buyer
    expect(await error(buyTransfer(book, budi, sale, 42, pair()))).toBe("invalid_request");
    const bought = await buyTransfer(book, budi, sale, 42, pair(), "555");
    expect(bought.windowUntil - now()).toBe(TRANSFER_WINDOW_SECONDS.game_item);
    const offer = { trade_offer_state: 2, accountid_other: 555, time_escrow_end: 0, items_to_give: [{ appid: 730, assetid: "1000000001" }] };
    steam.set("77001", offer);
    // sent, not accepted
    expect(await book.proof(bought.transferId, { tradeoffer_id: "77001" })).toMatchObject({ outcome: "pending", missing: { tradeOfferState: 2 } });
    // accepted, but Steam holds the trade for ten more minutes: the book says how long
    steam.set("77001", { ...offer, trade_offer_state: 3, time_escrow_end: now() + 600 });
    expect(await book.proof(bought.transferId)).toMatchObject({ outcome: "pending", missing: { retryAfterSeconds: 600 } });
    // the hold ends
    market.clock.now += 601_000;
    steam.set("77001", { ...offer, trade_offer_state: 3, time_escrow_end: now() - 1 });
    const done = await waitForProof(book, bought.transferId, { tries: 2, wait });
    expect(done.outcome).toBe("confirmed");
    expect(releasedVoucher((done as { transfer: any }).transfer).voucher.payee).toBe(andi.account);
    // the key of Steam is in the URL to Steam only: not in what the buyer got
    expect(JSON.stringify(done)).not.toContain(STEAM_KEY);
  });

  it("TC-AG-031-03 a ticket: only the buyer confirms, a ticket above 100 credit is refused by the SDK before anything is sent", async () => {
    const { book, actor, expiresAt, pair } = await start();
    const [andi, budi, citra] = [actor("andi"), actor("budi"), actor("citra")];
    expect(() => prepareTransfer(book, andi, { platform: "ticket", ref: "gate-A-17", price: credit(101), estimateSeconds: 600, nonce: "tk0", expiresAt })).toThrow(TransferError);
    const sale = prepareTransfer(book, andi, { platform: "ticket", ref: "gate-A-17", price: credit(60), estimateSeconds: 600, nonce: "tk1", expiresAt });
    await postTransfer(book, andi, sale);
    const bought = await buyTransfer(book, budi, sale, 42, pair());
    expect(bought.windowUntil - book.at()).toBe(TRANSFER_WINDOW_SECONDS.ticket);
    // the platform cannot prove a ticket: the proof route says so
    expect(await error(book.proof(bought.transferId))).toBe("transfer_bad_method");
    // the seller cannot say it arrived, and neither can a stranger
    expect(await error(book.transferNotice(bought.transferId, andi, "confirmed"))).toBe("transfer_not_party");
    expect(await error(book.transferNotice(bought.transferId, citra, "confirmed"))).toBe("transfer_not_party");
    const done = await book.transferNotice(bought.transferId, budi, "confirmed");
    expect(done.status).toBe("confirmed");
    expect(releasedVoucher(done).voucher).toMatchObject({ payer: budi.account, payee: andi.account, cumulativeAmount: credit(60) });
  });

  it("TC-AG-031-04 a seller who does not transfer is not paid: the window passes, the voucher never moves, and the buyer can buy again from the same pair", async () => {
    const { book, actor, expiresAt, pair } = await start();
    const [andi, budi] = [actor("andi"), actor("budi")];
    const sale = prepareTransfer(book, andi, { platform: "domain", ref: DOMAIN, price: credit(30), estimateSeconds: 3600, nonce: "dom2", expiresAt });
    dns.set(DOMAIN, [sale.sellerTxt!]);
    await postTransfer(book, andi, sale);
    const p = pair();
    const before = { ...p };
    const bought = await buyTransfer(book, budi, sale, 42, p);
    // seven days and a little pass: nothing was transferred and the buyer set no TXT
    market.clock.now += (TRANSFER_WINDOW_SECONDS.domain + 60) * 1000;
    const late = await book.getTransfer(bought.transferId);
    expect([late.status, late.cancelReason, late.voucher]).toEqual(["cancelled", "transfer_window_passed", undefined]);
    expect((await book.proof(bought.transferId)).outcome).toBe("window_passed");
    expect(() => releasedVoucher(late)).toThrow(BookError);
    // the voucher never moved: the pair goes back, and the same voucher number is accepted for a new purchase
    releasePair(p, before);
    const again = await buyTransfer(book, budi, sale, 42, p);
    expect([again.status, again.transferId === bought.transferId]).toEqual(["paid_held", false]);
    // the failure counts against the seller in the reputation, once per buyer, and only from a buyer that has paid somebody
    market.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, registration_mode, registered_block, receipt_id) VALUES (?, 42, ?, ?, 1, 5000000, 'cumulative', 1, 'r1')").run(CIRCLE_ID, budi.account, acct("citra"));
    const rep = await (await fetch(`${market.srv.url}/x207/circles/${CIRCLE_ID}/reputation/${andi.account}`)).json();
    expect(rep.abandoned).toEqual({ transactions: 1, counterparties: 1 });
  });
});
