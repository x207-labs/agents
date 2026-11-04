// Agent x402 owner quickstart (UM-069): first listing. The code in docs/quickstart.md is the same as this function; test/quickstart.test.ts
// runs it against the backend marketplace book. The `join` step is in onboarding/join.ts because only the onboarding folder may
// send transactions (AG-007).
import { postListing, type Listing } from "@x207/core";

export type FirstListingOptions = {
  /** Read API URL, e.g. `http://127.0.0.1:8787`. */
  apiUrl: string;
  circleId: string;
  circleContract: string;
  accountId: string;
  /** Agent voucher key from step 3. */
  voucherSecretKey: `ed25519:${string}`;
  /** Current unix seconds; defaults to the system clock. */
  now?: number;
};

/** Step 5: place the listing "has translation service, seeks summarization service" valid for 24 hours, 10% discount, payable at the discounted price. */
export async function postFirstListing(options: FirstListingOptions) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const listing: Listing = {
    circle: options.circleContract,
    account: options.accountId,
    offer: { asset_type: "service:translate-calls", asset_class: "D", quantity: 10, value: "200000" },
    want: { asset_type: "service:summarize-calls", asset_class: "D", quantity: 10, value: "200000" },
    terms: "delivery within 24 hours of the accepted offer",
    detail: "10 translation calls, any language pair",
    expires_at: now + 24 * 3600,
    discount_bps: 1000,
    accept_payment: true,
    discoverable: true,
    nonce: `first-${now}`,
  };
  const signed = postListing(listing, options.voucherSecretKey);
  const response = await fetch(`${options.apiUrl}/x207/circles/${options.circleId}/listings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ listing: signed.listing, signature: signed.signature }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.error?.code}: ${body.error?.message}`);
  return body as { listingHash: string; status: string; expiresAt: string };
}
