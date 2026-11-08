// Agent identity: ed25519 voucher key (ADR-06, not a NEAR access key) and the owner spend policy (FX-AG-4).
// Stored per account at <keysDir>/<network>/<account>.agent.json with mode 0600; the secret is never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Spend limits in credit smallest units (6 decimals), decimal string. */
export type SpendPolicy = {
  /** Limit per paid call. */
  maxPerCall: string;
  /** Total limit per epoch. */
  maxPerEpoch: string;
};

export type AgentIdentity = {
  accountId: string;
  voucherSecretKey: `ed25519:${string}`;
  voucherPublicKey: `ed25519:${string}`;
  policy: SpendPolicy;
};

const POSITIVE = /^[1-9]\d*$/;

export function parseSpendPolicy(raw: unknown): SpendPolicy {
  const value = raw as Partial<SpendPolicy> | null;
  for (const field of ["maxPerCall", "maxPerEpoch"] as const) {
    if (typeof value?.[field] !== "string" || !POSITIVE.test(value[field]!)) {
      throw new Error(`spend policy: ${field} must be an integer string > 0`);
    }
  }
  if (BigInt(value!.maxPerCall!) > BigInt(value!.maxPerEpoch!)) {
    throw new Error("spend policy: maxPerCall must not exceed maxPerEpoch");
  }
  return { maxPerCall: value!.maxPerCall!, maxPerEpoch: value!.maxPerEpoch! };
}

export function loadSpendPolicy(file: string): SpendPolicy {
  if (!existsSync(file)) throw new Error(`spend policy file does not exist: ${file}`);
  return parseSpendPolicy(JSON.parse(readFileSync(file, "utf8")));
}

export const identityPath = (keysDir: string, network: string, accountId: string): string =>
  join(keysDir, network, `${accountId}.agent.json`);

export function saveIdentity(keysDir: string, network: string, identity: AgentIdentity): string {
  const file = identityPath(keysDir, network, identity.accountId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700); // also a directory that already existed with wider bits (F8, review BE-063)
  // A-AG-17: write a temporary file and rename it, so a crash never leaves a half-written key file under the real name
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return file;
}

/** Read the agent identity when the agent starts; `null` if not yet onboarded. */
export function loadIdentity(keysDir: string, network: string, accountId: string): AgentIdentity | null {
  const file = identityPath(keysDir, network, accountId);
  if (!existsSync(file)) return null;
  // F8 (review BE-063): like ssh, refuse a key file that other users can read or write
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`agent key file ${file} is open to group or other users (mode ${mode.toString(8)}): run chmod 600 and treat the key as possibly leaked`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as AgentIdentity;
  return { ...raw, policy: parseSpendPolicy(raw.policy) };
}
