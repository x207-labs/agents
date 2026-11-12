// AG-051: the appraised listing of scripts/ag051-appraised-listing.ts, signed by a real member of a circle instead of a throwaway key, so a backend
// accepts it. The script reads one member's voucher key from a JSON keys file (never printed, never written), checks that its public key is the one the
// circle holds for that member, asks the appraiser, and writes only `{ listing, signature }` to X207_SIGNED_OUT. It posts nothing.
// Run:
//   X207_MEMBER_KEYS_FILE=<keys.json> X207_MEMBER=alice X207_MEMBER_ACCOUNT=alice.example.testnet X207_CONTRACT_ID=<circle contract> \
//   X207_BACKEND_URL=https://<backend> X207_SIGNED_OUT=<out.json> node scripts/ag051-member-listing.ts
// The keys file maps a member name to `{ voucher: "ed25519:..." }`. X207_APPRAISER_URL defaults to X207_BACKEND_URL.
// X207_LISTING_EXPIRES_AT (ISO time or unix seconds) sets when the listing expires; without it the agent's default applies (24 hours).
import { readFileSync, writeFileSync } from "node:fs";
import { listingHash, voucherPublicKey } from "@x207/core";
import { AppraiserClient } from "../shared/appraiser.ts";
import { DEFAULT_BARTER_POLICY, PolicyAgent } from "../shared/barter-policy.ts";
import type { BookClient } from "../shared/barter.ts";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}
const keysFile = need("X207_MEMBER_KEYS_FILE");
const member = need("X207_MEMBER");
const account = need("X207_MEMBER_ACCOUNT");
const contractId = need("X207_CONTRACT_ID");
const backend = need("X207_BACKEND_URL").replace(/\/$/, "");
const out = need("X207_SIGNED_OUT");
const circle = process.env.X207_CIRCLE_ID ?? "agents-main";
const startedAt = Math.floor(Date.now() / 1000);
const expiresRaw = process.env.X207_LISTING_EXPIRES_AT;
const expiresAt = expiresRaw ? (/^\d+$/.test(expiresRaw) ? Number(expiresRaw) : Math.floor(Date.parse(expiresRaw) / 1000)) : undefined;
if (expiresAt !== undefined && !(expiresAt > startedAt)) throw new Error(`X207_LISTING_EXPIRES_AT "${expiresRaw}" is not a time in the future`);

const entry = (JSON.parse(readFileSync(keysFile, "utf8")) as Record<string, { voucher?: string }>)[member];
if (!entry?.voucher?.startsWith("ed25519:")) throw new Error(`no voucher key for member "${member}" in the keys file`);
const secretKey = entry.voucher as `ed25519:${string}`;
const publicKey = voucherPublicKey(secretKey);

// the circle must hold this very key for this account, and the member must be active, or the backend answers 401 invalid_signature
const members = (await (await fetch(`${backend}/x207/circles/${circle}/members`)).json()) as { items: { account: string; status: string; pubkeyVoucher: string }[] };
const held = members.items.find((m) => m.account === account);
if (!held) throw new Error(`${account} is not a member of ${circle}`);
if (held.status !== "active") throw new Error(`${account} is ${held.status}, not active`);
if (held.pubkeyVoucher !== publicKey) throw new Error(`the key of "${member}" is not the voucher key the circle holds for ${account}`);

const signed: { listing: unknown; signature: string }[] = [];
const book = { postListing: async (listing: unknown, signature: string) => { signed.push({ listing, signature }); return {}; } } as unknown as BookClient;
const agent = new PolicyAgent({
  identity: { accountId: account, voucherSecretKey: secretKey, voucherPublicKey: publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "10000000" } },
  book,
  contractId,
  // a fixed clock, so that expires_at = startedAt + listingTtlSeconds is exactly the time asked for
  now: () => startedAt,
  policy: {
    ...DEFAULT_BARTER_POLICY,
    ...(expiresAt !== undefined ? { listingTtlSeconds: expiresAt - startedAt } : {}),
    // the same holding as ag051-appraised-listing.ts: 10 bundles of 10000 geocoding calls, 7.5 credit each (75 in total)
    holdings: [{ assetType: "api_quota", assetClass: "B", quantity: 10, unitValue: "7500000" }],
    needs: [{ assetType: "service:summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: "5000000" }],
  },
  appraiser: {
    client: new AppraiserClient({ baseUrl: process.env.X207_APPRAISER_URL ?? backend }),
    describe: () => ({
      scope: "10 bundles of 10000 forward geocoding calls each, read-only, 10 requests per second",
      provider: "Mapbox",
      duration_days: 30,
      description: "Seat of a monthly plan; the key stays with the seller, the buyer calls through the seller's proxy.",
    }),
  },
});

const result = await agent.list();
if (signed.length !== 1) throw new Error(`expected one signed listing, got ${signed.length}`);
writeFileSync(out, `${JSON.stringify(signed[0])}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  account,
  key_matches_circle: true,
  appraisal: result.appraisal ? { id: result.appraisal.appraisal_id, cached: result.appraisal.cached, value_credits: result.appraisal.result?.value_credits, verified: result.appraisal.verified } : null,
  appraisal_error: result.appraisalError ?? null,
  listing: { hash: listingHash(result.listing), offer: result.listing.offer, detail: result.listing.detail, expires_at: result.listing.expires_at },
  written: out,
}, null, 1));
