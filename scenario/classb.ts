// Class B demo scenario (AG-015, F8): the owner rents out NEAR account access through a function-call key, the renter pays rent with a plain x402 voucher to the broker
// and receives that key, calls the allowed method, then another method and attached funds are rejected by the NEAR protocol itself. When the renter is `defaulted`,
// the broker deletes the key. This module only holds the roles and the order; all I/O (transactions, HTTP, access keys) is injected by the caller, because the agent
// must not hold account access keys (AG-007); the grantor and renter transactions (offer_grant, accept_grant) live in onboarding/rental.ts: the voucher key only signs vouchers, and the renter's own function-call key is used through
// the `callWithKey` provided by the orchestration (demo/classb.demo.ts).
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { base58Encode } from "@x207/core";

export const CLASS_B_ASSET_TYPE = "near-rpc:access";
const DAY_MS = 86_400_000;
export const DEFAULT_ALLOWANCE = "1000000000000000000000000";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** New ed25519 access key in NEAR format (`ed25519:<base58>`); secret key = 32-byte seed + public key. */
export type AccessKey = { publicKey: string; secretKey: string };

export function newAccessKey(seed: Uint8Array = randomBytes(32)): AccessKey {
  const spki = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(spki.subarray(spki.length - 32));
  return { publicKey: `ed25519:${base58Encode(publicKey)}`, secretKey: `ed25519:${base58Encode(Buffer.concat([Buffer.from(seed), Buffer.from(publicKey)]))}` };
}

/** Class B `scope` (Contract Interface Spec 15.1): the key may only call `methodNames` on `receiverId`, with gas up to `allowance` yoctoNEAR. */
export function rentalScope(receiverId: string, methodNames: readonly string[], allowance: string = DEFAULT_ALLOWANCE): string {
  return JSON.stringify({ receiver_id: receiverId, method_names: methodNames, allowance });
}

export type LeaseResult = { status: number; body: Record<string, unknown>; paymentResponse: boolean };

/** The renter requests rent from the broker through `buy` (x402 fetch with a voucher); the 402 is paid automatically, and the result is the installed key until `paidUntil`. */
export async function payLease(o: { buy: typeof fetch; brokerUrl: string; grantId: number }): Promise<LeaseResult> {
  const response = await o.buy(`${o.brokerUrl}/grants/${o.grantId}/lease`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, paymentResponse: response.headers.get("PAYMENT-RESPONSE") !== null };
}

/** Result of one call with the function-call key: success or rejected (protocol error message). */
export type KeyCallOutcome = { ok: true; hash: string } | { ok: false; error: string };
/** `attachedYocto` = funds attached to the call; a function-call key must not attach any. */
export type CallWithKey = (key: AccessKey, methodName: string, attachedYocto: bigint) => Promise<KeyCallOutcome>;

export type KeyProbe = { allowed: KeyCallOutcome; otherMethod: KeyCallOutcome; withFunds: KeyCallOutcome };

/** The NEAR protocol itself restricts the key: the allowed method runs, other methods and attached funds are rejected. No x207 code is on this path. */
export async function probeKey(call: CallWithKey, key: AccessKey, allowedMethod: string, otherMethod: string): Promise<KeyProbe> {
  return {
    allowed: await call(key, allowedMethod, 0n),
    otherMethod: await call(key, otherMethod, 0n),
    withFunds: await call(key, allowedMethod, 1n),
  };
}

/** The forbidden calls really fail and the valid call really runs; otherwise the scenario fails. */
export function assertProbe(probe: KeyProbe): void {
  if (!probe.allowed.ok) throw new Error(`the allowed call failed: ${probe.allowed.error}`);
  if (probe.otherMethod.ok) throw new Error("a method outside the list should be rejected");
  if (probe.withFunds.ok) throw new Error("a call with attached funds should be rejected");
}

/** One rental day in milliseconds, to compute `expires_at` and `paidUntil`. */
export const RENTAL_DAY_MS = DAY_MS;
