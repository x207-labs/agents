// AG-051: one demo agent asks the x207 appraiser (backend BE-119, NEAR AI Cloud) before it prices a listing, then signs the listing
// with the appraisal named in `detail`. Dry run: the signed listing is printed, not posted, so no circle membership is needed.
// Run: X207_APPRAISER_URL=http://127.0.0.1:8791 node scripts/ag051-appraised-listing.ts
// The backend holds the NEAR AI key; this script needs none.
import { generateVoucherKeypair, listingHash } from "@x207/core";
import { AppraiserClient } from "../shared/appraiser.ts";
import { DEFAULT_BARTER_POLICY, PolicyAgent } from "../shared/barter-policy.ts";
import type { BookClient } from "../shared/barter.ts";

const baseUrl = process.env.X207_APPRAISER_URL;
if (!baseUrl) throw new Error("set X207_APPRAISER_URL to the backend base URL");

const keys = generateVoucherKeypair();
const signed: unknown[] = [];
const book = { postListing: async (listing: unknown, signature: string) => { signed.push({ listing, signature }); return {}; } } as unknown as BookClient;
const agent = new PolicyAgent({
  identity: { accountId: "geocoder.x207.testnet", voucherSecretKey: keys.secretKey, voucherPublicKey: keys.publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "10000000" } },
  book,
  contractId: process.env.X207_CONTRACT_ID ?? "x207.testnet",
  now: () => Math.floor(Date.now() / 1000),
  policy: {
    ...DEFAULT_BARTER_POLICY,
    // the owner prices 10 bundles of 10000 geocoding calls at 7.5 credit each (75 in total)
    holdings: [{ assetType: "api_quota", assetClass: "B", quantity: 10, unitValue: "7500000" }],
    needs: [{ assetType: "service:summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: "5000000" }],
  },
  appraiser: {
    client: new AppraiserClient({ baseUrl }),
    describe: () => ({
      scope: "10 bundles of 10000 forward geocoding calls each, read-only, 10 requests per second",
      provider: "Mapbox",
      duration_days: 30,
      description: "Seat of a monthly plan; the key stays with the seller, the buyer calls through the seller's proxy.",
    }),
  },
});

const t0 = Date.now();
const out = await agent.list();
console.log(JSON.stringify({
  ms: Date.now() - t0,
  appraisal: out.appraisal ? { id: out.appraisal.appraisal_id, model: out.appraisal.model, cached: out.appraisal.cached, result: out.appraisal.result, verified: out.appraisal.verified } : null,
  appraisal_error: out.appraisalError ?? null,
  owner_total: "75000000",
  listing: { hash: listingHash(out.listing), offer: out.listing.offer, detail: out.listing.detail },
  signed: signed.length,
}, null, 1));
