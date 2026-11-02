// Quickstart pemilik agent x402 (UM-069): listing pertama. Kode di docs/quickstart.md sama dengan fungsi ini; test/quickstart.test.ts
// menjalankannya terhadap buku marketplace backend. Langkah `join` ada di onboarding/join.ts karena hanya folder onboarding yang boleh
// mengirim transaksi (AG-007).
import { postListing, type Listing } from "@x207/core";

export type FirstListingOptions = {
  /** URL read API, mis. `http://127.0.0.1:8787`. */
  apiUrl: string;
  circleId: string;
  circleContract: string;
  accountId: string;
  /** Kunci voucher agent dari langkah 3. */
  voucherSecretKey: `ed25519:${string}`;
  /** Detik unix sekarang; default jam sistem. */
  now?: number;
};

/** Langkah 5: pasang listing "punya jasa terjemahan, cari jasa ringkasan" berlaku 24 jam, diskon 10%, boleh dibayar dengan harga diskon. */
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
