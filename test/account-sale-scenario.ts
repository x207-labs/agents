// AG-050 (P1, UM-076, contract 0.0.18, ADR `docs/adr-0.0.18.md` of `contracts`, branch `p1-0.0.18`): the sale of a NEAR account through the locker contract, as an agent would play it.
// Item #11: a named account is locked by its seller, checked by the buyer BEFORE paying (SD-119, `checkAccountLockBeforePay`), paid with a voucher and received as the only key.
// Item #14: the same for an account that is a member of the circle; the buyer must wait one epoch, then the voucher key of the member is the key of the buyer.
// Item #12 (a Chain Signatures address): the seller lists an account for the backend (BE-110), which refuses any account with a `sign` call to the MPC contract. There is no MPC contract
// here: `FakeMpc` is a signer of ours that records the calls, so the history the backend reads is the one we wrote. The part on chain is the same as for #11.
// This file is in `test/` because what it sends are owner and seller actions (the registry, the lock), outside the AG-007 agent policy.
import { createHash } from "node:crypto";
import { checkAccountLockBeforePay, signVoucher, type AccountId, type AccountLockReason, type ContractCall } from "@x207/core";

export type Send = (account: AccountId, call: ContractCall & { gas?: bigint }) => Promise<{ failures: string[]; logs: string[]; value: unknown; hash?: string }>;
/** Where a run writes its trace: one line per step with the state it saw, so that a failure leaves more than the first failed assertion. Set by the test; absent in other uses. */
export type Trace = (line: string) => void;
export type AccountSaleStep = { item: string; step: string; ok: boolean; detail: string };

export type AccountSaleWorld = {
  circle: AccountId;
  /** The grantor: a member that is paid. Not the sold account (ERR_ACCOUNT_SELF). */
  seller: AccountId;
  buyer: AccountId;
  buyerVoucherKey: `ed25519:${string}`;
  /** The account that is sold, with full access keys of its own that the lock removes. */
  sold: AccountId;
  /** The public key the seller gets back if the sale is refused or cancelled. */
  returnKey: string;
  /** The public key the buyer receives with the account. ED25519. */
  deliveryKey: string;
  rpcUrl: string;
  send: Send;
  view: (contractId: AccountId, method: string, args: object) => Promise<unknown>;
  /** Block time of the chain in nanoseconds. */
  nowNs: () => Promise<bigint>;
  /** The seller's one transaction on the sold account: deploy the locker, call `new`, delete every key. */
  lock: (grantId: number, returnKey: string) => Promise<{ failures: string[] }>;
  keysOf: (account: AccountId) => Promise<string[]>;
  /** Close, commit and finalize the open epoch, so that the next one is open. */
  nextEpoch: () => Promise<void>;
  trace?: Trace;
};

const PRICE = "1000000";
const DAY_NS = 86_400_000_000_000n;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 of bytes, the form of `code_hash` in `view_account` and in `get_locker_code_hashes`. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
/** The hash the owner publishes with `set_locker_code_hashes` for a locker wasm. */
export const lockerCodeHash = (wasm: Uint8Array): string => base58(createHash("sha256").update(wasm).digest());

/** A stand-in for the MPC contract (`v1.signer`): it signs nothing real, it only remembers who asked. The backend reads this record as the sign history of an account. */
export class FakeMpc {
  readonly calls: Array<{ account: string; path: string }> = [];
  sign(account: string, path: string): string {
    this.calls.push({ account, path });
    return createHash("sha256").update(`fake-mpc\0${account}\0${path}\0${this.calls.length}`).digest("hex");
  }
  /** The shape the backend asks for (`AccountHistory.signCalls`). */
  signCalls(account: string): Promise<{ count: number; complete: boolean }> {
    return Promise.resolve({ count: this.calls.filter((c) => c.account === account).length, complete: true });
  }
}

let seq = 0;

/** The owner registers the two entries of the ADR in the registry D10 (class A, delivery `escrow_account`) and publishes the official hash of the locker. */
export async function prepareRegistry(w: Pick<AccountSaleWorld, "circle" | "send">, owner: AccountId, lockerHash: string): Promise<void> {
  for (const assetType of ["near:account", "near:member_account"]) {
    const entry = { asset_type: assetType, class: "A", delivery_methods: ["escrow_account"], accepted_proofs: [], terms_hash: "5a".repeat(32) };
    const r = await w.send(owner, { receiverId: w.circle, methodName: "set_asset_class", args: { asset_type: assetType, entry }, deposit: 0n, gas: 100_000_000_000_000n });
    if (r.failures.length > 0) throw new Error(`set_asset_class ${assetType}: ${r.failures.join("; ")}`);
  }
  const r = await w.send(owner, { receiverId: w.circle, methodName: "set_locker_code_hashes", args: { hashes: [lockerHash] }, deposit: 0n, gas: 100_000_000_000_000n });
  if (r.failures.length > 0) throw new Error(`set_locker_code_hashes: ${r.failures.join("; ")}`);
}

async function offer(w: AccountSaleWorld, assetType: string): Promise<number> {
  const expires = (await w.nowNs()) + 3n * DAY_NS;
  const r = await w.send(w.seller, {
    receiverId: w.circle, methodName: "offer_grant", deposit: 0n, gas: 100_000_000_000_000n,
    args: { input: { asset_type: assetType, delivery_method: "escrow_account", limits: { scope: JSON.stringify({ account_id: w.sold }), quota: null, expires_at: expires.toString() }, unit: "once", unit_price: PRICE, operator: null, proof_hash: null, proof_kind: null } },
  });
  if (r.failures.length > 0) throw new Error(`offer_grant: ${r.failures.join("; ")}`);
  return Number(r.value);
}

/**
 * What an agent does before paying for an account: the pre-pay check of the SDK, and the payment only if it passes. Returns the reasons when it does not, and then sends nothing.
 */
export async function payIfSafe(w: AccountSaleWorld, grantId: number, waitSeconds = 0, trace: Trace = () => {}): Promise<{ paid: false; reasons: AccountLockReason[] } | { paid: true; failures: string[] }> {
  // The check reads the chain at final finality, which trails the lock by a few blocks: right after the lock it can still say `locker_not_held`. A buyer asks again; `waitSeconds` is that.
  const deadline = Date.now() + waitSeconds * 1000;
  let check = await checkAccountLockBeforePay({ circle: w.circle, grantId, soldAccount: w.sold, rpcUrls: [w.rpcUrl], circleView: (method, args) => w.view(w.circle, method, args ?? {}) });
  while (!check.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    check = await checkAccountLockBeforePay({ circle: w.circle, grantId, soldAccount: w.sold, rpcUrls: [w.rpcUrl], circleView: (method, args) => w.view(w.circle, method, args ?? {}) });
  }
  trace(`pre-pay check of grant ${grantId}: ${check.ok ? "ok" : `refused ${check.reasons.join(",")}`}`);
  if (!check.ok) return { paid: false, reasons: check.reasons };
  const epoch = Number(((await w.view(w.circle, "get_epoch", {})) as { epoch: number }).epoch);
  seq += 1;
  const { signature, ...voucher } = signVoucher(
    { circle: w.circle, payer: w.buyer, payee: w.seller, epoch, seq, cumulativeAmount: String(BigInt(PRICE) * BigInt(seq)), unit: "credit", resource: `https://x207.example/grants/${grantId}` },
    w.buyerVoucherKey,
  );
  const bought = await w.send(w.buyer, { receiverId: w.circle, methodName: "complete_account_escrow", args: { grant_id: grantId, voucher, signature, delivery_pubkey: w.deliveryKey }, deposit: 0n, gas: 250_000_000_000_000n });
  trace(`complete_account_escrow grant ${grantId} at epoch ${epoch}: tx ${bought.hash ?? "?"} failures ${JSON.stringify(bought.failures)} logs ${JSON.stringify(bought.logs)}`);
  return { paid: true, failures: bought.failures };
}

const escrowState = async (w: AccountSaleWorld, grantId: number): Promise<string> => String(((await w.view(w.circle, "get_account_escrow", { grant_id: grantId })) as { state?: string } | null)?.state);
const lockerState = async (w: AccountSaleWorld): Promise<string> => String(((await w.view(w.sold, "get_state", {})) as { state?: string } | null)?.state);

/** Item #11 (and the on-chain part of #12): offer, a refused pre-pay check on an account that is not locked, the lock, a passing check, the payment, the only key. */
export async function runNamedAccountSale(w: AccountSaleWorld, item = "11"): Promise<AccountSaleStep[]> {
  const steps: AccountSaleStep[] = [];
  const note = (step: string, ok: boolean, detail: string) => { steps.push({ item, step, ok, detail }); w.trace?.(`#${item} ${ok ? "ok  " : "FAIL"} ${step} :: ${detail}`); };
  const id = await offer(w, "near:account");
  note("offer_grant", id >= 0, `grant ${id}`);

  const before = await payIfSafe(w, id).catch((e: unknown) => ({ paid: false as const, reasons: [`error: ${(e as Error).message}`] as unknown as AccountLockReason[] }));
  note("check before the lock refuses and nothing is sent", !before.paid && before.reasons.includes("keys_left"), before.paid ? "paid" : before.reasons.join(","));

  const locked = await w.lock(id, w.returnKey);
  const keys = await w.keysOf(w.sold);
  note("lock", locked.failures.length === 0 && keys.length === 0 && (await lockerState(w)) === "held" && (await escrowState(w, id)) === "held", `keys ${keys.length}, locker ${await lockerState(w).catch(() => "none")}, escrow ${await escrowState(w, id)}`);

  const paid = await payIfSafe(w, id, 60, w.trace);
  const after = await w.keysOf(w.sold);
  note("pay after a passing check", paid.paid && paid.failures.length === 0 && (await escrowState(w, id)) === "delivered" && (await lockerState(w)) === "released" && after.length === 1 && after[0] === w.deliveryKey,
    paid.paid ? `escrow ${await escrowState(w, id)}, locker ${await lockerState(w)}, keys ${after.length}` : paid.reasons.join(","));
  return steps;
}

/** Item #14: the sold account is a member. The check passes, the payment is refused in the epoch of the lock, and goes through after one epoch with the voucher key rotated. */
export async function runMemberAccountSale(w: AccountSaleWorld): Promise<AccountSaleStep[]> {
  const steps: AccountSaleStep[] = [];
  const t = w.trace ?? (() => {});
  // every step is written to the trace the moment it is known, with the whole state (not cut), so that a later throw cannot hide it
  const note = (step: string, ok: boolean, detail: string) => { steps.push({ item: "14", step, ok, detail }); t(`#14 ${ok ? "ok  " : "FAIL"} ${step} :: ${detail}`); };
  let gid = -1;
  const snapshot = async (label: string) => {
    const [escrow, member, keys, epoch] = await Promise.all([
      w.view(w.circle, "get_account_escrow", { grant_id: gid }).catch(() => "n/a"),
      w.view(w.circle, "member", { account_id: w.sold }).catch((e: unknown) => `error ${(e as Error).message}`),
      w.keysOf(w.sold).catch(() => ["error"]),
      w.view(w.circle, "get_epoch", {}).catch(() => null),
    ]);
    t(`#14 state ${label}: epoch ${JSON.stringify(epoch)} member ${JSON.stringify(member)} keys ${JSON.stringify(keys)} (escrow of grant ${gid} ${JSON.stringify(escrow)})`);
  };
  const id = await offer(w, "near:member_account");
  gid = id;
  note("offer_grant", id >= 0, `grant ${id}`);
  const locked = await w.lock(id, w.returnKey);
  note("lock", locked.failures.length === 0 && (await escrowState(w, id)) === "held", `failures ${JSON.stringify(locked.failures)}; escrow ${await escrowState(w, id)}`);
  await snapshot("after lock");

  const same = await payIfSafe(w, id, 60, t);
  const refused = same.paid && same.failures.some((f) => f.includes("ERR_ESCROW_EPOCH_WAIT"));
  note("same epoch is refused (ERR_ESCROW_EPOCH_WAIT) and the account keeps no key", refused && (await w.keysOf(w.sold)).length === 0 && (await escrowState(w, id)) === "held",
    same.paid ? `failures ${JSON.stringify(same.failures)}; keys ${(await w.keysOf(w.sold)).length}; escrow ${await escrowState(w, id)}` : `check refused: ${same.reasons.join(",")}`);
  await snapshot("after the refused payment");

  await w.nextEpoch();
  await snapshot("after nextEpoch");
  const paid = await payIfSafe(w, id, 60, t);
  const member = (await w.view(w.circle, "member", { account_id: w.sold })) as { pubkey_voucher?: string } | null;
  const keys = await w.keysOf(w.sold);
  note("pay after one epoch: only key and voucher key are the buyer's", paid.paid && paid.failures.length === 0 && keys.length === 1 && keys[0] === w.deliveryKey && member?.pubkey_voucher === w.deliveryKey,
    paid.paid ? `failures ${JSON.stringify(paid.failures)}; keys ${JSON.stringify(keys)} (delivery ${w.deliveryKey}); member voucher key ${member?.pubkey_voucher}; escrow ${await escrowState(w, id)}` : `check refused: ${paid.reasons.join(",")}`);
  await snapshot("end");
  return steps;
}
