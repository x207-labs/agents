// AG-055: a barter ring of three agents on a live circle in which the goods move, not only the credit. Each member holds one class A asset (an NFT of the
// barter catalog) and sells it to the next member: A -> B -> C -> A. Each asset is appraised by the live x207 appraiser (POST /x207/appraise), offered as a
// class A grant at that price, or at a fixed price when the appraisals give no usable ring, with the reason kept (`offer_grant`), handed to the circle by its seller (`nft_transfer_call`, the circle holds it: event `escrow_held`), and bought
// by the next member with a voucher (`complete_escrow`): the voucher is registered and the circle sends the NFT to the buyer (`on_escrow_resolved`).
// The three purchases land in one epoch, so they form one cycle of debt: the epoch is closed, the cycle is cleared (submit_clearing nets the smallest leg on
// every edge), committed, the net residue is paid in USDT, the epoch is finalized and the creditors claim. The same steps as AG-052
// (scripts/demo-barter-cycle.ts), with a real delivery of each asset in place of a bundle of promises.
// Testnet only. The NFTs are minted on the mock NFT contract of the batch 1 run (probes/mock_nft, nft_mint is open); USDT is the mock USDT of the circle.
// The keys file maps a member name to { access: "ed25519:...", voucher: "ed25519:..." } (the file of AG-052); keys are read here and never printed or written.
// When the circle does not know the three asset types yet, the owner of the circle registers them from the catalog (X207_OWNER_KEY_FILE, a near-cli key file).
// Run (from the agents repo):
//   X207_MEMBER_KEYS_FILE=<p1-v018-keys.json> X207_OWNER_KEY_FILE=<x207-v18-own.testnet.json> X207_DEMO_OUT=docs/demo-barter-ring-assets.json node scripts/demo-barter-ring-assets.ts
// Optional: X207_CONTRACT_ID (x207-v018.testnet), X207_BACKEND_URL (https://v018.x207.boxd.sh), X207_CIRCLE_ID (agents-main), NEAR_RPC_URL, NEAR_ARCHIVAL_RPC_URL,
// X207_USDT_ID, X207_NFT_ID (nft.x207-b1-aux.testnet), X207_RING (as in AG-052), X207_DASHBOARD_URL, X207_DASHBOARD_CIRCLE (v018).
// Safe to repeat: the out file keeps the finished steps and the run resumes from it; once it is finished, only the evidence is read again.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetTemplate, signVoucher, voucherPublicKey, type AssetInput } from "@x207/core";
import { AppraiserClient, creditUnits, creditsOf, type AppraisalAsset } from "../shared/appraiser.ts";
import { checkRingPrices, clearRing, escrowWindowOpen, eventsOf, nextVoucher, ringLegs, ringTokenId } from "./lib/ring-assets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nearApi = createRequire(resolve(here, "../../sdk/package.json"))("near-api-js");
const { Account, JsonRpcProvider, KeyPair, KeyPairSigner } = nearApi;
// the catalog of asset types of the umbrella repository (the same entries the batch 1 run registered on its circle)
const { CATALOG, registerCatalog } = (await import(new URL("../../scripts/lib/asset-catalog.mjs", import.meta.url).href)) as {
  CATALOG: { assetType: string }[];
  registerCatalog: (o: { view: (m: string, a: object) => Promise<unknown>; send: (c: { methodName: string; args: object }) => Promise<string>; catalog: unknown[] }) => Promise<{ missing: string[]; wrong: string[]; written: unknown[] }>;
};

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};
const CONTRACT = process.env.X207_CONTRACT_ID ?? "x207-v018.testnet";
const BACKEND = (process.env.X207_BACKEND_URL ?? "https://v018.x207.boxd.sh").replace(/\/$/, "");
const CIRCLE_ID = process.env.X207_CIRCLE_ID ?? "agents-main";
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const ARCHIVAL = process.env.NEAR_ARCHIVAL_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com";
const USDT = process.env.X207_USDT_ID ?? "usdt.x207-deployer.testnet";
const NFT = process.env.X207_NFT_ID ?? "nft.x207-b1-aux.testnet";
const DASHBOARD = (process.env.X207_DASHBOARD_URL ?? "https://x207.vercel.app").replace(/\/$/, "");
const DASHBOARD_CIRCLE = process.env.X207_DASHBOARD_CIRCLE ?? "v018";
const OUT = resolve(need("X207_DEMO_OUT"));
const KEYS = JSON.parse(readFileSync(need("X207_MEMBER_KEYS_FILE"), "utf8")) as Record<string, { access?: string; voucher?: string }>;
const RING = (process.env.X207_RING ?? "alice:alice.x207-v18-own.testnet,bob:bob.x207-v18-own.testnet,dan2:dan2.x207-v18-own.testnet:buyer14b")
  .split(",")
  .map((pair) => {
    const [name, account, keyEntry] = pair.split(":");
    if (!name || !account) throw new Error(`X207_RING entry "${pair}" is not name:account[:key entry]`);
    return { name, account, keyEntry };
  });
if (RING.length !== 3) throw new Error("X207_RING must name three members");
/** Time `complete_escrow` gets per call when the script checks that the three purchases fit before the cutoff (the contract wants 120 s more). */
const PER_PURCHASE_MS = 40_000;
/** How long a grant stays offered: long enough to wait for a fresh epoch and to rerun, far below get_max_escrow_ttl (72 h on v018). */
const GRANT_HOURS = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- the three assets, one per member, all class A NFTs of the barter catalog (scripts/lib/asset-catalog.mjs: 5, 2 and 3). The token itself is a mock NFT
// on testnet that stands for the asset; the appraiser is told so. `market` is the hint of the seller to the appraiser, the price is what the appraiser answers.
type RingAsset = { catalog_no: number; kind: "license" | "ticket" | "game-item"; asset_type: string; appraisal: AppraisalAsset; fallback_credits: string };
const ASSETS: Record<string, RingAsset> = {
  [RING[0]!.name]: {
    catalog_no: 5,
    kind: "license",
    asset_type: "license:software-nft",
    fallback_credits: "24",
    appraisal: {
      asset_type: "license:software-nft",
      asset_class: "A",
      quantity: 1,
      scope: "One transferable 12-month seat of a code editor license, held as an NFT; the holder of the NFT is the licensee",
      provider: "Editor Pro (demo issuer, NFT on NEAR testnet)",
      duration_days: 365,
      market_price_credits: "24",
      description: "Seat license as an NFT on NEAR testnet (a mock NFT contract stands for the issuer); the token moves to the buyer through the escrow of the circle.",
    },
  },
  [RING[1]!.name]: {
    catalog_no: 2,
    kind: "ticket",
    asset_type: "ticket:event-nft",
    fallback_credits: "32",
    appraisal: {
      asset_type: "ticket:event-nft",
      asset_class: "A",
      quantity: 1,
      scope: "One admission ticket to a one-day developer conference, held as an NFT; the holder of the NFT gets in",
      provider: "NEAR builders day (demo organizer, NFT on NEAR testnet)",
      duration_days: 7,
      market_price_credits: "32",
      description: "Event ticket as an NFT on NEAR testnet (a mock NFT contract stands for the organizer); the token moves to the buyer through the escrow of the circle.",
    },
  },
  [RING[2]!.name]: {
    catalog_no: 3,
    kind: "game-item",
    asset_type: "game:item-nft",
    fallback_credits: "25",
    appraisal: {
      asset_type: "game:item-nft",
      asset_class: "A",
      quantity: 1,
      scope: "One rare sword of an on-chain dungeon game, held as an NFT; the holder of the NFT can equip it in the game",
      provider: "Dungeons (demo game, NFT on NEAR testnet)",
      duration_days: null,
      market_price_credits: "25",
      description: "Game item as an NFT on NEAR testnet (a mock NFT contract stands for the game); the token moves to the buyer through the escrow of the circle.",
    },
  },
};

// ---- state file: every finished step stays there, a rerun resumes
type Step = { label: string; ok: boolean; tx: string; signer: string; receiver: string; method: string; failure: string | null; value: unknown; events: { standard: string; event: string; data: unknown }[] };
type Listing = { seller: string; buyer: string; asset_type: string; catalog_no: number; token_id: string; grant_id?: number; price_units?: string; price_source?: "appraiser" | "fixed"; owners: Record<string, string | null> };
type Out = {
  item: "AG-055";
  contract: string;
  circle: string;
  nft_contract: string;
  started_at: string;
  run_tag: string;
  members: { name: string; account: string; sells: string }[];
  appraisals: Record<string, unknown>;
  listings: Record<string, Listing>;
  epoch?: number;
  steps: Step[];
  result?: unknown;
  finished_at?: string;
};
const out: Out = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : { item: "AG-055", contract: CONTRACT, circle: CIRCLE_ID, nft_contract: NFT, started_at: new Date().toISOString(), run_tag: String(Math.floor(Date.now() / 1000)), members: [], appraisals: {}, listings: {}, steps: [] };
const save = () => writeFileSync(OUT, `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
if (out.finished_at) console.log(`${OUT} holds a finished run (epoch ${out.epoch}): only the evidence is written again; move the file away for a new run`);

// ---- chain access
async function rpcAt(url: string, method: string, params: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const b = (await r.json()) as { result?: unknown; error?: unknown };
      if (b.error) throw new Error(JSON.stringify(b.error));
      return b.result;
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}
const rpc = (method: string, params: unknown) => rpcAt(RPC, method, params);
const view = async (method: string, args: Record<string, unknown> = {}, account = CONTRACT): Promise<any> =>
  JSON.parse(
    Buffer.from(
      (await rpc("query", { request_type: "call_function", finality: "optimistic", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })).result,
    ).toString("utf8"),
  );
const chainMs = async () => Number(BigInt((await rpc("block", { finality: "optimistic" })).header.timestamp_nanosec) / 1_000_000n);
const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);
async function waitUntilMs(targetMs: number, why: string, pollMs = 30_000) {
  for (;;) {
    const now = await chainMs();
    if (now >= targetMs) return;
    const left = targetMs - now;
    console.log(`waiting ${Math.ceil(left / 1000)}s for ${why}`);
    await sleep(Math.max(500, Math.min(left + 500, pollMs)));
  }
}
const ownerOf = async (tokenId: string): Promise<string | null> => ((await view("nft_token", { token_id: tokenId }, NFT)) as { owner_id?: string } | null)?.owner_id ?? null;

const provider = new JsonRpcProvider({ url: RPC });
// A member account that was bought (an account sale of the catalog) is held by its buyer: then one key entry of the buyer, its `delivery` key, is
// both the full-access key and the voucher key of the member (name:account:<key entry> in X207_RING).
const keyOf = (name: string, kind: "access" | "voucher"): string => {
  const entry = RING.find((m) => m.name === name)?.keyEntry;
  const key = entry ? (KEYS[entry] as { delivery?: string } | undefined)?.delivery : KEYS[name]?.[kind];
  if (!key?.startsWith("ed25519:")) throw new Error(`no ${kind} key for member "${name}" in the keys file`);
  return key;
};
const accounts: Record<string, any> = Object.fromEntries(RING.map((m) => [m.name, new Account(m.account, provider, new KeyPairSigner(KeyPair.fromString(keyOf(m.name, "access"))))]));
const accountOf = Object.fromEntries(RING.map((m) => [m.name, m.account])) as Record<string, string>;
const nameOf = Object.fromEntries(RING.map((m) => [m.account, m.name])) as Record<string, string>;
/** The member with the most NEAR sends the permissionless calls (mint of the mock NFT, close, clearing, commit, finalize). */
let relayer = RING[0]!.name;

function failureText(outcome: any): string | null {
  const found = [outcome.status, ...(outcome.receipts_outcome ?? []).map((o: any) => o.outcome.status)].find((s) => s && typeof s === "object" && "Failure" in s);
  if (!found) return null;
  const text = JSON.stringify(found);
  const m = text.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/) ?? text.match(/"FunctionCallError":\{"[A-Za-z]+":"((?:[^"\\]|\\.)*)"/);
  return m ? m[1]!.replace(/\\"/g, '"') : text.slice(0, 300);
}
const valueOf = (outcome: any) => {
  const v = outcome.status?.SuccessValue;
  return v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : null;
};
async function send(label: string, from: string, receiver: string, method: string, args: unknown, { deposit = 0n, gas = 100_000_000_000_000n, tolerate }: { deposit?: bigint; gas?: bigint; tolerate?: string } = {}): Promise<Step> {
  const previous = out.steps.find((s) => s.label === label && s.ok);
  if (previous) {
    console.log(`${label}: already done (${previous.tx})`);
    return previous;
  }
  const account = from === "owner" ? owner() : accounts[from];
  let outcome: any;
  try {
    outcome = await account.callFunctionRaw({ contractId: receiver, methodName: method, args, deposit, gas, waitUntil: "FINAL" });
  } catch (e: any) {
    if (!e?.transactionResult?.transaction_outcome) throw e;
    outcome = e.transactionResult;
  }
  const failure = failureText(outcome);
  const logs = [...(outcome.transaction_outcome?.outcome?.logs ?? []), ...(outcome.receipts_outcome ?? []).flatMap((o: any) => o.outcome.logs as string[])];
  const step: Step = { label, ok: failure === null, tx: outcome.transaction_outcome.id, signer: account.accountId, receiver, method, failure, value: valueOf(outcome), events: eventsOf(logs) };
  out.steps = out.steps.filter((s) => s.label !== label);
  out.steps.push(step);
  save();
  console.log(`${step.ok ? "ok  " : "FAIL"} ${label} ${step.tx}${failure ? ` ${failure}` : ""}`);
  if (!step.ok && !(tolerate && failure?.includes(tolerate))) throw new Error(`${label}: ${failure}`);
  return step;
}
const circleCall = (label: string, from: string, method: string, args: unknown, opts?: Parameters<typeof send>[5]) => send(label, from, CONTRACT, method, args, opts);
let ownerAccount: any;
function owner(): any {
  if (ownerAccount) return ownerAccount;
  const file = JSON.parse(readFileSync(need("X207_OWNER_KEY_FILE"), "utf8")) as { account_id?: string; private_key?: string; secret_key?: string };
  const secret = file.private_key ?? file.secret_key;
  if (!secret?.startsWith("ed25519:")) throw new Error("X207_OWNER_KEY_FILE has no ed25519 key");
  ownerAccount = new Account(file.account_id ?? "x207-v18-own.testnet", provider, new KeyPairSigner(KeyPair.fromString(secret)));
  return ownerAccount;
}

// ---- 1. the members: active, the voucher key in the file is the one the circle holds, the access key is on the account
for (const m of RING) {
  const member = await view("member", { account_id: m.account });
  if (!member || member.status !== "active") throw new Error(`${m.account} is not an active member of ${CONTRACT}`);
  if (member.pubkey_voucher !== voucherPublicKey(keyOf(m.name, "voucher") as `ed25519:${string}`)) throw new Error(`the voucher key of "${m.name}" is not the one ${CONTRACT} holds`);
  const keys = (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: m.account })).keys.map((k: { public_key: string }) => k.public_key);
  if (!keys.includes(KeyPair.fromString(keyOf(m.name, "access")).getPublicKey().toString())) throw new Error(`the access key of "${m.name}" is not on ${m.account}`);
}
// the NEAR a member can spend: its balance minus what the storage of its account holds (1e19 yocto per byte); a member account with a contract on it
// (dan2 holds the locker code of its account sale) keeps most of its balance for storage
const balances = await Promise.all(
  RING.map(async (m) => {
    const a = await rpc("query", { request_type: "view_account", finality: "final", account_id: m.account });
    return BigInt(a.amount) - BigInt(a.storage_usage) * 10_000_000_000_000_000_000n;
  }),
);
relayer = RING[balances.indexOf(balances.reduce((a, b) => (b > a ? b : a)))]!.name;
out.members = RING.map((m) => ({ name: m.name, account: m.account, sells: ASSETS[m.name]!.asset_type }));
save();
// complete_escrow attaches 250 Tgas, which the signer must hold in NEAR before the call (about 0.25 NEAR, the unused part comes back): a member below
// MIN_NEAR gets a plain NEAR transfer from the relayer, recorded like every other step (testnet NEAR, not part of the barter)
const MIN_NEAR = 400_000_000_000_000_000_000_000n;
const TOP_UP = 500_000_000_000_000_000_000_000n;
for (const [i, m] of RING.entries()) {
  const label = `fund ${m.name} with 0.5 NEAR from ${relayer} (gas of complete_escrow)`;
  if (out.finished_at || m.name === relayer || balances[i]! >= MIN_NEAR || out.steps.some((s) => s.label === label && s.ok)) continue;
  const outcome: any = await accounts[relayer].signAndSendTransaction({ receiverId: m.account, actions: [nearApi.actions.transfer(TOP_UP)], waitUntil: "FINAL" });
  const failure = failureText(outcome);
  out.steps.push({ label, ok: failure === null, tx: outcome.transaction_outcome.id, signer: accountOf[relayer]!, receiver: m.account, method: "transfer", failure, value: null, events: [] });
  save();
  console.log(`${failure ? "FAIL" : "ok  "} ${label} ${outcome.transaction_outcome.id}`);
  if (failure) throw new Error(`${label}: ${failure}`);
}

// ---- 2. the circle knows the three asset types as class A (registered from the catalog by the owner, once)
const wanted = new Set(Object.values(ASSETS).map((a) => a.asset_type));
const catalog = CATALOG.filter((e) => wanted.has(e.assetType));
if (catalog.length !== wanted.size) throw new Error("the catalog does not hold the three asset types");
const known = ((await view("list_asset_classes", { from_index: 0, limit: 100 })) as { asset_type: string; class: string }[]).filter((e) => wanted.has(e.asset_type) && e.class === "A");
if (known.length !== wanted.size) {
  const registered = await registerCatalog({
    view: (method, args) => view(method, args as Record<string, unknown>),
    send: async ({ methodName, args }) => (await circleCall(`set_asset_class ${(args as { asset_type: string }).asset_type}`, "owner", methodName, args)).tx,
    catalog,
  });
  if (registered.missing.length || registered.wrong.length) throw new Error(`asset types not registered: ${JSON.stringify(registered)}`);
}

// ---- 3. appraise the three assets with the live appraiser. The appraised values are the prices when all three are signed and positive and leave a residue;
// otherwise the three fixed prices are used and the reason is kept next to the appraisals (an appraiser that values a mock NFT of testnet at about 0 is right,
// but a ring at 0 credit moves nothing worth clearing).
const appraiser = new AppraiserClient({ baseUrl: BACKEND, timeoutMs: 120_000 });
type Appraised = { holder: string; catalog_no: number; asset: AppraisalAsset; appraisal_id?: string; value_credits?: string; signed?: boolean; error?: string; url?: string } & Record<string, unknown>;
for (const m of RING) {
  if (out.appraisals[m.name]) continue;
  const a = ASSETS[m.name]!;
  try {
    const r = await appraiser.appraise(a.appraisal);
    out.appraisals[m.name] = {
      holder: m.account,
      catalog_no: a.catalog_no,
      asset: a.appraisal,
      appraisal_id: r.appraisal_id,
      model: r.model,
      cached: r.cached,
      value_credits: r.result.value_credits,
      range: r.result.range,
      confidence: r.result.confidence,
      flags: r.result.flags,
      rationale: r.result.rationale,
      signed: r.verified.signature,
      verified: r.verified,
      url: `${BACKEND}/x207/appraisals/${r.appraisal_id}`,
    };
    console.log(`appraised ${a.asset_type} of ${m.name}: ${r.result.value_credits} credit (${r.appraisal_id})`);
  } catch (e) {
    out.appraisals[m.name] = { holder: m.account, catalog_no: a.catalog_no, asset: a.appraisal, error: (e as Error).message };
    console.log(`no appraisal for ${a.asset_type} of ${m.name}: ${(e as Error).message}`);
  }
  save();
}
const appraised = RING.map((m) => out.appraisals[m.name] as Appraised);
const signedOf = (a: Appraised): boolean => a.signed ?? (a.verified as { signature?: boolean } | undefined)?.signature ?? false;
const appraisedPrices = appraised.map((a) => (signedOf(a) && a.value_credits ? creditUnits(a.value_credits) : 0n));
let priceSource: "appraiser" | "fixed" = "appraiser";
let fixedReason: string | null = null;
try {
  checkRingPrices(appraisedPrices);
} catch (e) {
  priceSource = "fixed";
  fixedReason = `the live appraiser gave ${appraised.map((a, i) => `${RING[i]!.name} ${a.value_credits ?? a.error ?? "no value"}${a.value_credits && !signedOf(a) ? " (unsigned)" : ""}`).join(", ")} credit: ${(e as Error).message}; a mock NFT of testnet has no market value, so the ring uses fixed prices`;
  console.log(`fixed prices: ${fixedReason}`);
}
const prices = Object.fromEntries(RING.map((m, i) => [m.name, priceSource === "appraiser" ? appraisedPrices[i]! : creditUnits(ASSETS[m.name]!.fallback_credits)])) as Record<string, bigint>;
checkRingPrices(Object.values(prices));
out.result = { ...(out.result as object), pricing: { source: priceSource, reason: fixedReason, prices_credit: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, creditsOf(v)])) } };
save();
const legs = ringLegs(RING, prices);
const planned = clearRing(legs);
for (const leg of legs) {
  const headroom = BigInt(await view("headroom", { account_id: accountOf[leg.buyer] }));
  const done = out.steps.some((s) => s.ok && s.label.startsWith(`complete_escrow ${leg.buyer} `));
  if (!done && leg.price > headroom) throw new Error(`${leg.buyer} has ${headroom} headroom, buying the asset of ${leg.seller} needs ${leg.price}`);
}

// ---- 4. each seller gets its NFT (minted on the mock contract), offers it as a class A grant at the price and hands it to the circle
const now = Math.floor((await chainMs()) / 1000);
for (const leg of legs) {
  const a = ASSETS[leg.seller]!;
  const tokenId = ringTokenId(out.run_tag, a.kind);
  const listing: Listing = (out.listings[leg.seller] ??= { seller: leg.seller, buyer: leg.buyer, asset_type: a.asset_type, catalog_no: a.catalog_no, token_id: tokenId, owners: {} });
  if ((await ownerOf(tokenId)) === null) await send(`nft_mint ${tokenId} to ${leg.seller}`, relayer, NFT, "nft_mint", { token_id: tokenId, owner_id: accountOf[leg.seller] });
  listing.owners.before_trade ??= await ownerOf(tokenId);
  if (listing.owners.before_trade !== accountOf[leg.seller]) throw new Error(`${tokenId} is held by ${listing.owners.before_trade}, not by ${leg.seller}`);
  save();
  if (listing.grant_id === undefined) {
    const expiresAt = now + GRANT_HOURS * 3600;
    const common = { nftContract: NFT, tokenId, unitPrice: leg.price.toString(), expiresAt };
    const input = (
      a.kind === "license"
        ? { kind: "license", product: "Editor Pro seat (demo)", termsHash: createHash("sha256").update(`x207 demo license terms ${tokenId}`).digest("hex"), seats: 1, ...common }
        : a.kind === "ticket"
          ? { kind: "ticket", event: { name: "NEAR builders day (demo)", startsAt: now + 7 * 86_400, endsAt: now + 8 * 86_400 }, ...common }
          : { kind: "game-item", game: { name: "Dungeons (demo)", collection: "swords" }, ...common }
    ) as AssetInput;
    const t = buildAssetTemplate(input, now);
    if (t.assetType !== a.asset_type) throw new Error(`the template of ${a.kind} makes ${t.assetType}, expected ${a.asset_type}`);
    const offered = await circleCall(`offer_grant ${leg.seller} (${a.asset_type} ${tokenId}, ${creditsOf(leg.price)} credit)`, leg.seller, "offer_grant", { input: t.grantInput });
    listing.grant_id = Number(offered.value);
    listing.price_units = leg.price.toString();
    listing.price_source = priceSource;
    save();
  }
  const grantId = listing.grant_id;
  const held = await view("get_escrow", { grant_id: grantId });
  if (!held) {
    const t = { receiverId: NFT, methodName: "nft_transfer_call", args: { receiver_id: CONTRACT, token_id: tokenId, msg: JSON.stringify({ grant_id: grantId }) }, deposit: 1n };
    await send(`nft_transfer_call ${leg.seller} ${tokenId} -> escrow of grant ${grantId}`, leg.seller, t.receiverId, t.methodName, t.args, { deposit: t.deposit, gas: 150_000_000_000_000n });
  }
  const escrow = await view("get_escrow", { grant_id: grantId });
  if (!escrow || (escrow.state !== "held" && escrow.state !== "delivered")) throw new Error(`grant ${grantId}: escrow is ${escrow?.state ?? "missing"}`);
  if (escrow.state === "held") listing.owners.in_escrow ??= await ownerOf(tokenId);
  save();
}

// ---- 5. the three purchases in one open epoch, each far enough from the cutoff (complete_escrow is refused in the last 120 s)
const pending = () => legs.filter((l) => !out.steps.some((s) => s.ok && s.label.startsWith(`complete_escrow ${l.buyer} `)));
if (out.epoch === undefined) {
  for (;;) {
    const e = await view("get_epoch", {});
    const nowMs = await chainMs();
    if (e.phase === "open" && escrowWindowOpen(nowMs, nsToMs(e.cutoff_at), pending().length, PER_PURCHASE_MS)) {
      out.epoch = e.epoch;
      save();
      break;
    }
    if (e.phase === "open") await waitUntilMs(nsToMs(e.cutoff_at), `cutoff of epoch ${e.epoch} (only ${Math.floor((nsToMs(e.cutoff_at) - nowMs) / 1000)}s left, three purchases need more)`);
    else {
      console.log(`epoch ${e.epoch} is ${e.phase}, waiting for the next open one`);
      await sleep(15_000);
    }
  }
}
const EPOCH = out.epoch!;
for (const leg of pending()) {
  const listing = out.listings[leg.seller]!;
  const e = await view("get_epoch", { epoch: EPOCH });
  if (e.phase !== "open" || !escrowWindowOpen(await chainMs(), nsToMs(e.cutoff_at), 1, PER_PURCHASE_MS))
    throw new Error(`epoch ${EPOCH} has no room for the purchase of ${listing.token_id} by ${leg.buyer}: the ring would be split over two epochs; stop here and check the state file`);
  const payer = accountOf[leg.buyer]!;
  const payee = accountOf[leg.seller]!;
  const lastSeq = Number(await view("last_seq", { payer, payee, epoch: EPOCH }));
  const pair = (await view("obligation", { epoch: EPOCH, debtor: payer, creditor: payee })) as { cumulative?: string } | null;
  if (lastSeq > 0 && !pair) throw new Error(`the pair ${leg.buyer} -> ${leg.seller} has seq ${lastSeq} but no obligation in epoch ${EPOCH}`);
  const v = nextVoucher(lastSeq, BigInt(pair?.cumulative ?? "0"), leg.price);
  const { signature, ...voucher } = signVoucher(
    { circle: CONTRACT, payer, payee, epoch: EPOCH, seq: v.seq, cumulativeAmount: v.cumulative.toString(), unit: "credit", resource: `x207:grant:${listing.grant_id}` } as never,
    keyOf(leg.buyer, "voucher") as `ed25519:${string}`,
  );
  await circleCall(`complete_escrow ${leg.buyer} buys ${listing.token_id} of ${leg.seller} (grant ${listing.grant_id}, ${creditsOf(leg.price)} credit)`, leg.buyer, "complete_escrow", { grant_id: listing.grant_id, voucher, signature }, { gas: 250_000_000_000_000n });
}
for (const leg of legs) {
  const listing = out.listings[leg.seller]!;
  const escrow = await view("get_escrow", { grant_id: listing.grant_id });
  if (escrow?.state !== "delivered") throw new Error(`grant ${listing.grant_id}: escrow is ${escrow?.state ?? "missing"} after complete_escrow`);
  listing.owners.after_trade ??= await ownerOf(listing.token_id);
  if (listing.owners.after_trade !== accountOf[leg.buyer]) throw new Error(`${listing.token_id} is held by ${listing.owners.after_trade}, not by the buyer ${leg.buyer}`);
}
save();

// ---- 6. close the epoch at its cutoff (the keeper may be first) and clear the cycle inside the proposal window
const epochView = async () => view("get_epoch", { epoch: EPOCH });
let e = await epochView();
if (e.phase === "open" || e.phase === "cutoff") {
  await waitUntilMs(nsToMs(e.cutoff_at), `cutoff of epoch ${EPOCH}`, 30_000);
  for (let attempt = 1; ; attempt++) {
    e = await epochView();
    if (e.phase !== "open" && e.phase !== "cutoff") break;
    const step = await circleCall(`close_epoch ${EPOCH}`, relayer, "close_epoch", { epoch: EPOCH }, { tolerate: "ERR_" });
    if (step.ok) break;
    if (attempt >= 8) throw new Error(`close_epoch ${EPOCH} refused ${attempt} times: ${step.failure}`);
    out.steps = out.steps.filter((s) => s.label !== `close_epoch ${EPOCH}`);
    save();
    await sleep(1_500);
  }
  e = await epochView();
}
// the debt of each leg: the buyer owes the seller
const ringPairs = legs.map((l) => ({ debtor: accountOf[l.buyer]!, creditor: accountOf[l.seller]! }));
const obligations = async () => Promise.all(ringPairs.map((p) => view("obligation", { epoch: EPOCH, ...p })));
if (e.phase === "clearing") {
  const before = await obligations();
  const cleared = before.reduce((min: bigint, o: any) => (BigInt(o.obligation) < min ? BigInt(o.obligation) : min), BigInt(before[0].obligation));
  const edges = before.map((o: any) => ({ debtor: o.debtor, creditor: o.creditor, cleared: cleared.toString() }));
  const simulated = await view("simulate_clearing", { epoch: EPOCH, edges });
  console.log(`simulate_clearing: ${JSON.stringify(simulated)}`);
  out.result = { ...(out.result as object), clearing_proposal: { edges, simulated } };
  save();
  if (simulated.valid && simulated.better_than_current) await circleCall(`submit_clearing ${EPOCH}`, relayer, "submit_clearing", { epoch: EPOCH, edges }, { gas: 200_000_000_000_000n, tolerate: "ERR_" });
  else console.log("submit_clearing skipped: a proposal as good is already there, or the proposal is not valid");
  e = await epochView();
}

// ---- 7. commit after the proposal deadline (the keeper may be first)
if (e.phase === "clearing" || e.phase === "commit") {
  await waitUntilMs(nsToMs(e.proposal_deadline) + 1_000, `proposal deadline of epoch ${EPOCH}`, 10_000);
  e = await epochView();
  if (e.phase === "clearing" || e.phase === "commit") await circleCall(`commit_epoch ${EPOCH}`, relayer, "commit_epoch", { epoch: EPOCH }, { tolerate: "ERR_WRONG_PHASE" });
  for (let i = 0; i < 20 && !["payment_window", "finalized"].includes((e = await epochView()).phase); i++) await sleep(3_000);
}
const afterClearing = await obligations();
const positionsAtCommit = ((out.result as { positions_at_commit?: any[] } | undefined)?.positions_at_commit ?? (await view("list_positions", { epoch: EPOCH, from_index: 0, limit: 50 }))) as any[];
out.result = { ...(out.result as object), obligations_after_clearing: afterClearing, positions_at_commit: positionsAtCommit };
save();

// ---- 8. the net debtors pay the residue in USDT inside the payment window
for (const p of positionsAtCommit.filter((p) => p.role === "debtor" && p.status === "due" && BigInt(p.amount) > 0n)) {
  const name = nameOf[p.account_id];
  if (!name) throw new Error(`a debtor outside the ring: ${p.account_id}`);
  await send(`settle epoch ${EPOCH} (${name} pays ${creditsOf(BigInt(p.amount))} USDT)`, name, USDT, "ft_transfer_call", { receiver_id: CONTRACT, amount: p.amount, msg: JSON.stringify({ action: "settle", epoch: EPOCH }) }, { deposit: 1n, gas: 150_000_000_000_000n });
}

// ---- 9. finalize at the payment deadline (the keeper may be first), then the creditors claim
e = await epochView();
if (e.phase !== "finalized") {
  await waitUntilMs(nsToMs(e.payment_deadline) + 1_000, `payment deadline of epoch ${EPOCH}`, 60_000);
  if ((await epochView()).phase !== "finalized") await circleCall(`finalize_epoch ${EPOCH}`, relayer, "finalize_epoch", { epoch: EPOCH }, { tolerate: "ERR_WRONG_PHASE" });
  for (let i = 0; i < 20 && (await epochView()).phase !== "finalized"; i++) await sleep(3_000);
}
const positionsFinal = (await view("list_positions", { epoch: EPOCH, from_index: 0, limit: 50 })) as any[];
for (const p of positionsFinal.filter((p) => p.role === "creditor" && BigInt(p.amount) > 0n)) {
  const name = nameOf[p.account_id];
  if (!name) continue;
  await circleCall(`claim epoch ${EPOCH} (${name}, near)`, name, "claim", { epoch: EPOCH, destination: "near" }, { deposit: 1n, gas: 120_000_000_000_000n, tolerate: "ERR_" });
}

// ---- 10. the evidence: every hash read back from an archival node, the owners of the tokens now, the clearing as the chain holds it and as planned
const final = await epochView();
const verified = [];
for (const s of out.steps.filter((s) => s.ok)) {
  const r = await rpcAt(ARCHIVAL, "tx", { tx_hash: s.tx, sender_account_id: s.signer, wait_until: "FINAL" });
  const failure = failureText(r);
  verified.push({ step: s.label, tx: s.tx, signer: s.signer, receiver: s.receiver, method: s.method, final_execution_status: r.final_execution_status ?? null, ok: failure === null, block_hash: r.transaction_outcome?.block_hash ?? null });
}
// a step the keeper of the circle sent first (commit_epoch, finalize_epoch) has no hash in the steps: it is read from the events of the backend (read-only),
// and its signer from the receipt on the archival node, so that it is checked like the others
const keeperSteps = [];
for (const [event, method] of [["epoch_committed", "commit_epoch"], ["epoch_finalized", "finalize_epoch"]] as const) {
  if (out.steps.some((s) => s.ok && s.method === method)) continue;
  let cursor = "";
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${BACKEND}/x207/circles/${CIRCLE_ID}/events?event=${event}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const body = (await r.json()) as { items?: { event: string; txHash: string; receiptId: string; blockHeight: number; data?: { epoch?: number } }[]; nextCursor?: string | null; more?: boolean };
    const hit = body.items?.find((ev) => ev.data?.epoch === EPOCH);
    if (hit) {
      const receipt = await rpcAt(ARCHIVAL, "EXPERIMENTAL_receipt", { receipt_id: hit.receiptId });
      const signer = receipt.receipt?.Action?.signer_id ?? receipt.predecessor_id;
      const t = await rpcAt(ARCHIVAL, "tx", { tx_hash: hit.txHash, sender_account_id: signer, wait_until: "FINAL" });
      keeperSteps.push({ step: `${method} ${EPOCH} (sent by the keeper, event ${event})`, tx: hit.txHash, signer, receiver: CONTRACT, method, block_height: hit.blockHeight, final_execution_status: t.final_execution_status ?? null, ok: failureText(t) === null });
      break;
    }
    if (!body.more || !body.nextCursor) break;
    cursor = body.nextCursor;
  }
}
const owners_now = Object.fromEntries(await Promise.all(Object.values(out.listings).map(async (l) => [l.token_id, await ownerOf(l.token_id)])));
const gross = legs.reduce((a, l) => a + l.price, 0n);
const clearedTotal = afterClearing.reduce((a: bigint, o: any) => a + BigInt(o.cleared), 0n);
const residueTotal = afterClearing.reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
const netOnChain = Object.fromEntries(
  RING.map((m) => {
    const owes = afterClearing.filter((o: any) => o.debtor === m.account).reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
    const owed = afterClearing.filter((o: any) => o.creditor === m.account).reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
    return [m.name, owed - owes];
  }),
) as Record<string, bigint>;
const matchesPlan = RING.every((m) => netOnChain[m.name] === planned.net[m.name]) && clearedTotal === planned.totals.cleared && residueTotal === planned.totals.residue;
const stepOf = (prefix: string) => out.steps.find((s) => s.ok && s.label.startsWith(prefix));
const ringPairSet = new Set(ringPairs.map((p) => `${p.debtor}>${p.creditor}`));
const otherObligations = ((await view("list_obligations", { epoch: EPOCH, from_index: 0, limit: 100 })) as any[]).filter((o) => !ringPairSet.has(`${o.debtor}>${o.creditor}`));
out.result = {
  ...(out.result as object),
  ring: legs.map((l, i) => {
    const listing = out.listings[l.seller]!;
    const o = afterClearing[i];
    const appraisal = out.appraisals[l.seller] as Appraised;
    return {
      seller: l.seller,
      buyer: l.buyer,
      asset_type: listing.asset_type,
      catalog_no: listing.catalog_no,
      nft_contract: NFT,
      token_id: listing.token_id,
      grant_id: listing.grant_id,
      price_credit: creditsOf(l.price),
      price_source: listing.price_source ?? priceSource,
      appraisal_id: appraisal.appraisal_id ?? null,
      appraised_credit: appraisal.value_credits ?? null,
      appraisal_url: appraisal.url ?? null,
      owner_before: listing.owners.before_trade,
      owner_in_escrow: listing.owners.in_escrow ?? null,
      owner_after: listing.owners.after_trade,
      owner_now: owners_now[listing.token_id],
      tx: {
        nft_mint: stepOf(`nft_mint ${listing.token_id} `)?.tx ?? null,
        offer_grant: stepOf(`offer_grant ${l.seller} `)?.tx ?? null,
        nft_transfer_call: stepOf(`nft_transfer_call ${l.seller} `)?.tx ?? null,
        complete_escrow: stepOf(`complete_escrow ${l.buyer} `)?.tx ?? null,
      },
      events: {
        nft_transfer_call: (stepOf(`nft_transfer_call ${l.seller} `)?.events ?? []).map((ev) => ev.event),
        complete_escrow: (stepOf(`complete_escrow ${l.buyer} `)?.events ?? []).map((ev) => ev.event),
      },
      gross_credit: creditsOf(l.price),
      cleared_credit: creditsOf(BigInt(o.cleared)),
      residue_credit: creditsOf(BigInt(o.obligation)),
    };
  }),
  totals: {
    gross_credit: creditsOf(gross),
    cleared_credit: creditsOf(clearedTotal),
    residue_credit: creditsOf(residueTotal),
    usdt_due_ring_only: creditsOf(planned.usdtDue),
    usdt_due_share_of_gross_bps: gross > 0n ? Number((planned.usdtDue * 10_000n) / gross) : 0,
    usdt_settled_on_chain: creditsOf(positionsAtCommit.filter((p) => p.role === "debtor").reduce((a: bigint, p: any) => a + BigInt(p.amount), 0n)),
    chain_matches_plan: matchesPlan,
  },
  per_member: Object.fromEntries(
    RING.map((m) => {
      const sold = legs.find((l) => l.seller === m.name)!;
      const bought = legs.find((l) => l.buyer === m.name)!;
      return [
        m.name,
        {
          account: m.account,
          sold: `${out.listings[m.name]!.token_id} to ${sold.buyer}`,
          bought: `${out.listings[bought.seller]!.token_id} of ${bought.seller}`,
          gross_owed_credit: creditsOf(sold.price),
          gross_owes_credit: creditsOf(bought.price),
          cleared_credit: creditsOf(planned.cleared),
          net_credit: (netOnChain[m.name]! < 0n ? "-" : "") + creditsOf(netOnChain[m.name]! < 0n ? -netOnChain[m.name]! : netOnChain[m.name]!),
        },
      ];
    }),
  ),
  other_obligations_in_epoch: otherObligations,
  epoch: { number: EPOCH, phase: final.phase, total_obligation: final.total_obligation, total_cleared: final.total_cleared, pool: final.pool, shortfall: final.shortfall },
  positions_final: positionsFinal,
  archival_check: { rpc: ARCHIVAL, method: "tx", params: "{tx_hash, sender_account_id, wait_until: FINAL}", all_ok: [...verified, ...keeperSteps].every((v) => v.ok && v.final_execution_status === "FINAL"), transactions: verified, keeper_transactions: keeperSteps },
  links: {
    dashboard_epoch: `${DASHBOARD}/stats?epoch=${EPOCH}&circle=${DASHBOARD_CIRCLE}`,
    api_epoch_metrics: `${BACKEND}/x207/circles/${CIRCLE_ID}/epochs/${EPOCH}/metrics`,
  },
};
if (final.phase === "finalized") out.finished_at ??= new Date().toISOString();
save();
const r = out.result as any;
console.log(JSON.stringify({ epoch: EPOCH, phase: final.phase, ring: r.ring.map((x: any) => `${x.seller}>${x.buyer} ${x.token_id} ${x.price_credit} ${x.owner_before} -> ${x.owner_after}`), totals: r.totals, per_member: r.per_member, archival_ok: r.archival_check.all_ok }, null, 1));
