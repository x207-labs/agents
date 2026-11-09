// AG-050 item #12 (P1, contract 0.0.18): the listing of an address that Chain Signatures derives from a NEAR account, against the real marketplace routes of the backend (BE-110) with a
// stand-in for the MPC contract (`FakeMpc`). Needs the backend branch `p1-0.0.18` next to this repo; skipped when the backend has no BE-110. The on-chain part of the sale is
// `account-sale.sandbox.test.ts`. Run: npx vitest run test/account-sale.test.ts
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { signListing, type Listing } from "@x207/core";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct, startMarket, type Market } from "./backend-fixtures.ts";
import { FakeMpc, base58, lockerCodeHash } from "./account-sale-scenario.ts";

const READY = BACKEND_AVAILABLE && existsSync(`${BACKEND_DIR}src/marketplace/account-escrow.ts`);
const NOW_S = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);
const TYPE = "chain-signatures:derived-address";

describe.skipIf(!READY)("AG-050 #12 listing of a Chain Signatures address", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function start(mpc?: FakeMpc) {
    market = await startMarket(["seller"], mpc === undefined ? {} : { accountHistory: mpc });
    market.db.prepare("INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, 'A', 1, 'r', 0)").run(CIRCLE_ID, TYPE);
    return market;
  }
  let nonce = 0;
  async function list(m: Market, sold: string) {
    const listing: Listing = {
      circle: CONTRACT, account: acct("seller"),
      offer: { asset_type: TYPE, asset_class: "A", quantity: 1, value: "1000000" },
      want: { asset_type: "credit", asset_class: "A", quantity: 1, value: "1000000" },
      terms: "the account is locked by the official locker; sub-accounts are not included", detail: JSON.stringify({ account_id: sold, kind: "account" }),
      expires_at: NOW_S + 3600, discount_bps: 0, accept_payment: true, discoverable: true, nonce: `acc-${++nonce}`,
    };
    const signature = signListing(listing, m.keys["seller"]!.secretKey);
    const res = await fetch(`${m.srv.url}/x207/circles/${CIRCLE_ID}/listings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing, signature }) });
    return { status: res.status, json: (await res.json()) as any };
  }

  it("TC-AG-050-12 an account that never called sign is listed; one that did is refused; the history is read again at each listing", async () => {
    const mpc = new FakeMpc();
    mpc.sign("used.testnet", "ethereum-1");
    const m = await start(mpc);
    const used = await list(m, "used.testnet");
    expect([used.status, used.json.error.code, used.json.error.details.signCalls]).toEqual([409, "account_has_sign_history", 1]);
    expect((await list(m, "clean.testnet")).status).toBe(201);
    // the same account signs once: the next listing of it is refused
    mpc.sign("late.testnet", "bitcoin-1");
    const late = await list(m, "late.testnet");
    expect([late.status, late.json.error.code]).toEqual([409, "account_has_sign_history"]);
  });

  it("TC-AG-050-13 a backend without an index of MPC calls refuses the listing (fail closed), and the seller is told why", async () => {
    const m = await start();
    const r = await list(m, "clean.testnet");
    expect([r.status, r.json.error.code]).toEqual([501, "account_history_not_configured"]);
  });

  it("TC-AG-050-14 base58 and the code hash: the alphabet of the chain, leading zero bytes as 1", () => {
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(base58(Uint8Array.from([255]))).toBe("5Q");
    expect(lockerCodeHash(new TextEncoder().encode("abc"))).toBe("DYu3G8aGTMBW1WrTw76zxQJQU4DHLw9MLyy7peG4LKkY"); // same as the `bs58` package for sha256("abc")
  });
});
