// AG-052: the core x207 demo, a circular barter of three agents on a live circle, from appraisal to a finalized epoch.
// Three members each hold a different digital asset (three classes of the barter catalog). Each asset is appraised by the live x207 appraiser
// (POST /x207/appraise). Every member takes the asset of the next one and owes the appraised value in credit: A -> B -> C -> A. The three legs are
// one barter bundle (F5): all three sign terms_hash, the bundle is committed, every leg is registered with a voucher of the bundle (F2 voucher path).
// Then the epoch is closed, the cycle is cleared (submit_clearing: the smallest leg is netted on every edge), committed, the net residue is paid in
// USDT, the epoch is finalized and the creditors claim. Without the barter every leg would move its full amount in USDT; with it only the residue does.
// Testnet only. The keys file maps a member name to { access: "ed25519:...", voucher: "ed25519:..." }; keys are read here and never printed or written.
// Run (from the agents repo):
//   X207_MEMBER_KEYS_FILE=<p1-v018-keys.json> X207_DEMO_OUT=docs/demo-barter-cycle.json node scripts/demo-barter-cycle.ts
// Optional: X207_CONTRACT_ID (x207-v018.testnet), X207_BACKEND_URL (https://v018.x207.boxd.sh), X207_CIRCLE_ID (agents-main), NEAR_RPC_URL,
// X207_USDT_ID, X207_RING ("alice:<account>,bob:<account>,dan2:<account>"), X207_DASHBOARD_URL, X207_DASHBOARD_CIRCLE (v018).
// Safe to repeat: the out file keeps the finished steps and the run resumes from it; once it is finished, delete it (or move it) for a new run.
// near-api-js comes from the sdk repo next to this one (the same copy the contract scripts use); the agents package does not depend on it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleInput, signBundle, signVoucher, termsHash, voucherPublicKey, type BundleTerms } from "@x207/core";
import { AppraiserClient, creditUnits, creditsOf, type AppraisalAsset } from "../shared/appraiser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nearApi = createRequire(resolve(here, "../../sdk/package.json"))("near-api-js");
const { Account, JsonRpcProvider, KeyPair, KeyPairSigner } = nearApi;

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};
const CONTRACT = process.env.X207_CONTRACT_ID ?? "x207-v018.testnet";
const BACKEND = (process.env.X207_BACKEND_URL ?? "https://v018.x207.boxd.sh").replace(/\/$/, "");
const CIRCLE_ID = process.env.X207_CIRCLE_ID ?? "agents-main";
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const USDT = process.env.X207_USDT_ID ?? "usdt.x207-deployer.testnet";
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
/** Seconds the open epoch must still have when the bundle is committed: signatures, the bundle and three vouchers fit easily in that. */
const MIN_OPEN_SECONDS = 240;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- the three assets, one per member and one class each (classes of scripts/lib/asset-catalog.mjs in the umbrella repo)
const ASSETS: Record<string, AppraisalAsset & { catalog_no: number }> = {
  [RING[0]!.name]: {
    catalog_no: 64,
    asset_type: "maps:geocoding-quota",
    asset_class: "C",
    quantity: 4,
    scope: "4 bundles of 10000 forward geocoding calls each, read-only, 10 requests per second, used through the seller's proxy",
    provider: "Mapbox",
    duration_days: 30,
    market_price_credits: "30",
    description: "Seat of a monthly plan; the API key stays with the seller, the buyer calls through the seller's proxy, one unit of quota per paid call.",
  },
  [RING[1]!.name]: {
    catalog_no: 5,
    asset_type: "license:software-nft",
    asset_class: "A",
    quantity: 1,
    scope: "One transferable 12-month seat of a developer tool license, held as an NFT; the holder of the NFT is the licensee",
    provider: "JetBrains",
    duration_days: 365,
    market_price_credits: "32",
    description: "Seat license as an NFT on NEAR; the license terms of the vendor apply to the new holder.",
  },
  [RING[2]!.name]: {
    catalog_no: 15,
    asset_type: "near-rpc:access",
    asset_class: "B",
    quantity: 1,
    scope: "Function-call access key to one NEAR account that holds a paid premium RPC subscription, limited to view calls, 30 days",
    provider: "FastNEAR",
    duration_days: 30,
    market_price_credits: "28",
    description: "The seller adds a function-call key for the buyer and removes it after 30 days; checked on chain with view_access_key.",
  },
};

// ---- state file: every finished step stays there, a rerun resumes
type Step = { label: string; ok: boolean; tx: string; failure: string | null; value: unknown };
type Out = {
  item: "AG-052";
  contract: string;
  circle: string;
  started_at: string;
  members: { name: string; account: string; asset: string }[];
  appraisals: Record<string, unknown>;
  epoch?: number;
  terms?: BundleTerms;
  terms_hash?: string;
  bundle_id?: number;
  steps: Step[];
  result?: unknown;
  finished_at?: string;
};
const out: Out = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : { item: "AG-052", contract: CONTRACT, circle: CIRCLE_ID, started_at: new Date().toISOString(), members: [], appraisals: {}, steps: [] };
const save = () => writeFileSync(OUT, `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
// a finished run is not run again: every step is skipped and only the evidence is written again from the chain (read-only); move the file for a new run
if (out.finished_at) console.log(`${OUT} holds a finished run (epoch ${out.epoch}): only the evidence is written again; move the file away for a new run`);

// ---- chain access
async function rpc(method: string, params: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const b = (await r.json()) as { result?: unknown; error?: unknown };
      if (b.error) throw new Error(JSON.stringify(b.error));
      return b.result;
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}
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

const provider = new JsonRpcProvider({ url: RPC });
// A member account that was bought (an account sale of the catalog) is held by its buyer: then one key entry of the buyer, its `delivery` key, is
// both the full-access key and the voucher key of the member (name:account:<key entry> in X207_RING).
const keyOf = (name: string, kind: "access" | "voucher"): string => {
  const entry = RING.find((m) => m.name === name)?.keyEntry;
  const key = entry ? (KEYS[entry] as { delivery?: string } | undefined)?.delivery : KEYS[name]?.[kind];
  if (!key?.startsWith("ed25519:")) throw new Error(`no ${kind} key for member "${name}" in the keys file`);
  return key;
};
const accounts = Object.fromEntries(RING.map((m) => [m.name, new Account(m.account, provider, new KeyPairSigner(KeyPair.fromString(keyOf(m.name, "access"))))]));
const accountOf = Object.fromEntries(RING.map((m) => [m.name, m.account])) as Record<string, string>;
const nameOf = Object.fromEntries(RING.map((m) => [m.account, m.name])) as Record<string, string>;
/** The member with the most NEAR sends the permissionless calls (commit_bundle, register_in_bundle, close, clearing, commit, finalize). */
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
  let outcome: any;
  try {
    outcome = await accounts[from].callFunctionRaw({ contractId: receiver, methodName: method, args, deposit, gas, waitUntil: "FINAL" });
  } catch (e: any) {
    if (!e?.transactionResult?.transaction_outcome) throw e;
    outcome = e.transactionResult;
  }
  const failure = failureText(outcome);
  const step: Step = { label, ok: failure === null, tx: outcome.transaction_outcome.id, failure, value: valueOf(outcome) };
  out.steps = out.steps.filter((s) => s.label !== label);
  out.steps.push(step);
  save();
  console.log(`${step.ok ? "ok  " : "FAIL"} ${label} ${step.tx}${failure ? ` ${failure}` : ""}`);
  if (!step.ok && !(tolerate && failure?.includes(tolerate))) throw new Error(`${label}: ${failure}`);
  return step;
}
const circleCall = (label: string, from: string, method: string, args: unknown, opts?: Parameters<typeof send>[5]) => send(label, from, CONTRACT, method, args, opts);

// ---- 1. the members: active, the voucher key in the file is the one the circle holds, the access key is on the account
for (const m of RING) {
  const member = await view("member", { account_id: m.account });
  if (!member || member.status !== "active") throw new Error(`${m.account} is not an active member of ${CONTRACT}`);
  if (member.pubkey_voucher !== voucherPublicKey(keyOf(m.name, "voucher") as `ed25519:${string}`)) throw new Error(`the voucher key of "${m.name}" is not the one ${CONTRACT} holds`);
  const keys = (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: m.account })).keys.map((k: { public_key: string }) => k.public_key);
  if (!keys.includes(KeyPair.fromString(keyOf(m.name, "access")).getPublicKey().toString())) throw new Error(`the access key of "${m.name}" is not on ${m.account}`);
}
const balances = await Promise.all(RING.map(async (m) => BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: m.account })).amount)));
relayer = RING[balances.indexOf(balances.reduce((a, b) => (b > a ? b : a)))]!.name;
out.members = RING.map((m) => ({ name: m.name, account: m.account, asset: ASSETS[m.name]!.asset_type }));
save();

// ---- 2. appraise the three assets with the live appraiser
const appraiser = new AppraiserClient({ baseUrl: BACKEND, timeoutMs: 120_000 });
for (const m of RING) {
  if (out.appraisals[m.name]) continue;
  const { catalog_no, ...asset } = ASSETS[m.name]!;
  const a = await appraiser.appraise(asset);
  if (!a.verified.signature) throw new Error(`the appraisal of ${asset.asset_type} has no checked signature (${a.appraisal_id})`);
  out.appraisals[m.name] = {
    holder: m.account,
    catalog_no,
    asset,
    appraisal_id: a.appraisal_id,
    model: a.model,
    cached: a.cached,
    value_credits: a.result.value_credits,
    range: a.result.range,
    confidence: a.result.confidence,
    flags: a.result.flags,
    verified: a.verified,
    url: `${BACKEND}/x207/appraisals/${a.appraisal_id}`,
  };
  save();
  console.log(`appraised ${asset.asset_type} of ${m.name}: ${a.result.value_credits} credit (${a.appraisal_id})`);
}
const valueOfAsset = (name: string) => creditUnits((out.appraisals[name] as { value_credits: string }).value_credits);

// ---- 3. the ring: member i takes the asset of member i+1 and owes its appraised value
const ringLegs = RING.map((m, i) => {
  const next = RING[(i + 1) % RING.length]!;
  return { payer: m.account, payee: next.account, max_amount: valueOfAsset(next.name).toString(), takes: ASSETS[next.name]!.asset_type };
});
for (const leg of ringLegs) {
  const headroom = BigInt(await view("headroom", { account_id: leg.payer }));
  if (BigInt(leg.max_amount) > headroom && !out.bundle_id) throw new Error(`${leg.payer} has ${headroom} headroom, the leg needs ${leg.max_amount}`);
}

if (out.bundle_id === undefined) {
  // a fresh open epoch with enough time left; the keeper of the backend moves epochs on its own, the script only waits
  let epoch: any;
  for (;;) {
    epoch = await view("get_epoch", {});
    const left = nsToMs(epoch.cutoff_at) - (await chainMs());
    if (epoch.phase === "open" && left > MIN_OPEN_SECONDS * 1000) break;
    if (epoch.phase === "open") await waitUntilMs(nsToMs(epoch.cutoff_at), `cutoff of epoch ${epoch.epoch} (only ${Math.floor(left / 1000)}s left)`);
    else {
      console.log(`epoch ${epoch.epoch} is ${epoch.phase}, waiting for the next open one`);
      await sleep(15_000);
    }
  }
  const legs = ringLegs.map(({ payer, payee, max_amount }) => ({ payer, payee, max_amount })).sort((a, b) => (a.payer !== b.payer ? (a.payer < b.payer ? -1 : 1) : a.payee < b.payee ? -1 : 1));
  const terms: BundleTerms = { circle: CONTRACT, epoch: epoch.epoch, legs };
  const signatures = RING.map((m) => {
    const s = signBundle(terms, m.account, keyOf(m.name, "voucher") as `ed25519:${string}`);
    return { account_id: s.account, signature: s.signature };
  });
  out.epoch = epoch.epoch;
  out.terms = terms;
  out.terms_hash = termsHash(terms);
  save();
  const step = await circleCall(`commit_bundle (epoch ${epoch.epoch})`, relayer, "commit_bundle", { bundle: bundleInput(terms), signatures }, { gas: 200_000_000_000_000n });
  out.bundle_id = Number(step.value);
  save();
}
const EPOCH = out.epoch!;
const BUNDLE = out.bundle_id!;
for (let i = 0; i < 30 && !(await view("get_bundle", { bundle_id: BUNDLE })); i++) await sleep(1_000);

// ---- 4. every leg is registered with a voucher of the bundle, signed by its payer
for (const leg of out.terms!.legs) {
  const payer = nameOf[leg.payer]!;
  const label = `register_in_bundle ${payer} -> ${nameOf[leg.payee]} (${creditsOf(BigInt(leg.max_amount))} credit)`;
  if (out.steps.some((s) => s.label === label && s.ok)) continue;
  const seq = Number(await view("last_seq", { payer: leg.payer, payee: leg.payee, epoch: EPOCH })) + 1;
  const { signature, ...voucher } = signVoucher(
    { circle: CONTRACT, payer: leg.payer, payee: leg.payee, epoch: EPOCH, seq, cumulativeAmount: leg.max_amount, unit: "credit", resource: `x207:bundle:${BUNDLE}` } as never,
    keyOf(payer, "voucher") as `ed25519:${string}`,
  );
  await circleCall(label, relayer, "register_in_bundle", { bundle_id: BUNDLE, voucher, signature });
}

// ---- 5. close the epoch at its cutoff (the keeper may be first) and clear the cycle inside the proposal window
const epochView = async () => view("get_epoch", { epoch: EPOCH });
let e = await epochView();
if (e.phase === "open" || e.phase === "cutoff") {
  await waitUntilMs(nsToMs(e.cutoff_at), `cutoff of epoch ${EPOCH}`, 30_000);
  // the last seconds: poll fast, the proposal window is short
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
const obligations = async () => Promise.all(out.terms!.legs.map((l) => view("obligation", { epoch: EPOCH, debtor: l.payer, creditor: l.payee })));
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

// ---- 6. commit after the proposal deadline (the keeper may be first)
if (e.phase === "clearing" || e.phase === "commit") {
  await waitUntilMs(nsToMs(e.proposal_deadline) + 1_000, `proposal deadline of epoch ${EPOCH}`, 10_000);
  e = await epochView();
  if (e.phase === "clearing" || e.phase === "commit") await circleCall(`commit_epoch ${EPOCH}`, relayer, "commit_epoch", { epoch: EPOCH }, { tolerate: "ERR_WRONG_PHASE" });
  for (let i = 0; i < 20 && !["payment_window", "finalized"].includes((e = await epochView()).phase); i++) await sleep(3_000);
}
const afterClearing = await obligations();
// the positions as the commit left them (status "due" for a debtor); a rerun keeps the first reading, later the debtor is "paid"
const positionsAtCommit = ((out.result as { positions_at_commit?: any[] } | undefined)?.positions_at_commit ?? (await view("list_positions", { epoch: EPOCH, from_index: 0, limit: 50 }))) as any[];
out.result = { ...(out.result as object), obligations_after_clearing: afterClearing, positions_at_commit: positionsAtCommit };
save();

// ---- 7. the net debtors pay the residue in USDT inside the payment window
for (const p of positionsAtCommit.filter((p) => p.role === "debtor" && p.status === "due" && BigInt(p.amount) > 0n)) {
  const name = nameOf[p.account_id];
  if (!name) throw new Error(`a debtor outside the ring: ${p.account_id}`);
  await send(`settle epoch ${EPOCH} (${name} pays ${creditsOf(BigInt(p.amount))} USDT)`, name, USDT, "ft_transfer_call", { receiver_id: CONTRACT, amount: p.amount, msg: JSON.stringify({ action: "settle", epoch: EPOCH }) }, { deposit: 1n, gas: 150_000_000_000_000n });
}

// ---- 8. finalize at the payment deadline (the keeper may be first), then the creditors claim
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

// ---- 9. the evidence
const final = await epochView();
// obligation view: `cumulative` = the gross of the pair, `cleared` = what the clearing netted, `obligation` = what is left after it (the residue)
const gross = out.terms!.legs.map((l) => BigInt(l.max_amount));
const grossTotal = gross.reduce((a, b) => a + b, 0n);
const clearedTotal = afterClearing.reduce((a: bigint, o: any) => a + BigInt(o.cleared), 0n);
const residueTotal = afterClearing.reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
const net = Object.fromEntries(
  RING.map((m) => {
    const owes = afterClearing.filter((o: any) => o.debtor === m.account).reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
    const owed = afterClearing.filter((o: any) => o.creditor === m.account).reduce((a: bigint, o: any) => a + BigInt(o.obligation), 0n);
    return [m.name, { account: m.account, net_credit: creditsOf(owed - owes), net_units: (owed - owes).toString() }];
  }),
);
const ringUsdt = Object.values(net).reduce((a, n) => (BigInt(n.net_units) < 0n ? a - BigInt(n.net_units) : a), 0n);
// other vouchers in the same epoch (another agent paying another one) are not part of the ring; the positions on chain then hold both
const ringPairs = new Set(out.terms!.legs.map((l) => `${l.payer}>${l.payee}`));
const otherObligations = ((await view("list_obligations", { epoch: EPOCH, from_index: 0, limit: 100 })) as any[]).filter((o) => !ringPairs.has(`${o.debtor}>${o.creditor}`));
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;
out.result = {
  ...(out.result as object),
  legs: out.terms!.legs.map((l, i) => {
    const o = afterClearing[i];
    return {
      payer: nameOf[l.payer],
      payee: nameOf[l.payee],
      payer_takes: ASSETS[nameOf[l.payee]!]!.asset_type,
      appraisal_id: (out.appraisals[nameOf[l.payee]!] as { appraisal_id: string }).appraisal_id,
      gross_credit: creditsOf(BigInt(l.max_amount)),
      cleared_credit: creditsOf(BigInt(o.cleared)),
      residue_credit: creditsOf(BigInt(o.obligation)),
    };
  }),
  totals: {
    gross_credit: creditsOf(grossTotal),
    cleared_credit: creditsOf(clearedTotal),
    residue_credit: creditsOf(residueTotal),
    // what the ring alone makes move in USDT: the sum of the net debts (a member with a residue in and out pays only the difference)
    usdt_due_ring_only: creditsOf(ringUsdt),
    usdt_due_ring_only_share_of_gross_bps: grossTotal > 0n ? Number((ringUsdt * 10_000n) / grossTotal) : 0,
    // what was paid on chain in the epoch (the positions also hold the other obligations of the epoch, if there are any)
    usdt_settled_on_chain: creditsOf(positionsAtCommit.filter((p) => p.role === "debtor").reduce((a: bigint, p: any) => a + BigInt(p.amount), 0n)),
  },
  net_per_member: net,
  other_obligations_in_epoch: otherObligations,
  epoch: { number: EPOCH, phase: final.phase, total_obligation: final.total_obligation, total_cleared: final.total_cleared, pool: final.pool, shortfall: final.shortfall },
  positions_final: positionsFinal,
  transactions: out.steps.filter((s) => s.ok).map((s) => ({ step: s.label, tx: s.tx, explorer: explorer(s.tx) })),
  links: {
    dashboard_epoch: `${DASHBOARD}/stats?epoch=${EPOCH}&circle=${DASHBOARD_CIRCLE}`,
    dashboard_report: `${DASHBOARD}/reports?epoch=${EPOCH}&circle=${DASHBOARD_CIRCLE}`,
    api_epoch_metrics: `${BACKEND}/x207/circles/${CIRCLE_ID}/epochs/${EPOCH}/metrics`,
    // the backend lists the bundles of a circle (there is no route for one bundle): look for bundleId in items
    api_bundles: `${BACKEND}/x207/circles/${CIRCLE_ID}/bundles`,
  },
};
if (final.phase === "finalized") out.finished_at = new Date().toISOString();
save();
console.log(JSON.stringify({ epoch: EPOCH, bundle_id: BUNDLE, phase: final.phase, ...(({ legs, totals, net_per_member, links }) => ({ legs, totals, net_per_member, links }))(out.result as any) }, null, 1));
