import { afterEach, describe, expect, it } from "vitest";
import { listingHash, type Listing } from "@x207/core";
import { postFirstListing } from "../scenario/quickstart.ts";
import { acct, BACKEND_AVAILABLE, CIRCLE_ID, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);

describe.skipIf(!BACKEND_AVAILABLE)("UM-069 quickstart: the first listing", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-UM-069-01 the quickstart code posts a listing that reads back from the read API", async () => {
    market = await startMarketBook(["translator"], { now: NOW * 1000 });
    const m = market;
    const apiUrl = m.url;
    const created = await postFirstListing({
      apiUrl, circleId: CIRCLE_ID, circleContract: CONTRACT, accountId: acct("translator"), voucherSecretKey: m.identities.translator!.voucherSecretKey, now: NOW,
    });
    expect(created.status).toBe("open");
    const [listed] = await m.book.listings({ status: "open" });
    expect(listed).toMatchObject({
      listingHash: created.listingHash, account: acct("translator"), discountBps: 1000, acceptPayment: true, discoverable: true,
      offer: { assetType: "service:translate-calls", assetClass: "D" },
    });
    expect(created.expiresAt).toBe("2026-11-05T10:00:00Z");
    // hash of the quickstart code equals the SDK hash over the same content
    const same: Listing = {
      circle: CONTRACT, account: acct("translator"),
      offer: { asset_type: "service:translate-calls", asset_class: "D", quantity: 10, value: "200000" },
      want: { asset_type: "service:summarize-calls", asset_class: "D", quantity: 10, value: "200000" },
      terms: "delivery within 24 hours of the accepted offer", detail: "10 translation calls, any language pair",
      expires_at: NOW + 86_400, discount_bps: 1000, accept_payment: true, discoverable: true, nonce: `first-${NOW}`,
    };
    expect(listingHash(same)).toBe(created.listingHash);
  });

  it("TC-UM-069-02 a wrong voucher key is rejected with invalid_signature", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: NOW * 1000 });
    const m = market;
    await expect(
      postFirstListing({
        apiUrl: m.url, circleId: CIRCLE_ID, circleContract: CONTRACT, accountId: acct("translator"), voucherSecretKey: m.identities.summarizer!.voucherSecretKey, now: NOW,
      }),
    ).rejects.toThrow(/401 invalid_signature/);
  });
});
