// Identitas agent: kunci voucher ed25519 (ADR-06, bukan access key NEAR) dan kebijakan belanja dari pemilik (FX-AG-4).
// Disimpan per akun di <keysDir>/<network>/<account>.agent.json dengan mode 0600; rahasia tidak pernah dicetak.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Batas belanja dalam satuan terkecil credit (6 desimal), string desimal. */
export type SpendPolicy = {
  /** Batas per panggilan berbayar. */
  maxPerCall: string;
  /** Batas total per epoch. */
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
      throw new Error(`kebijakan belanja: ${field} harus string bilangan bulat > 0`);
    }
  }
  if (BigInt(value!.maxPerCall!) > BigInt(value!.maxPerEpoch!)) {
    throw new Error("kebijakan belanja: maxPerCall tidak boleh melebihi maxPerEpoch");
  }
  return { maxPerCall: value!.maxPerCall!, maxPerEpoch: value!.maxPerEpoch! };
}

export function loadSpendPolicy(file: string): SpendPolicy {
  if (!existsSync(file)) throw new Error(`berkas kebijakan belanja tidak ada: ${file}`);
  return parseSpendPolicy(JSON.parse(readFileSync(file, "utf8")));
}

export const identityPath = (keysDir: string, network: string, accountId: string): string =>
  join(keysDir, network, `${accountId}.agent.json`);

export function saveIdentity(keysDir: string, network: string, identity: AgentIdentity): string {
  const file = identityPath(keysDir, network, identity.accountId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Baca identitas agent saat agent mulai; `null` bila belum di-onboard. */
export function loadIdentity(keysDir: string, network: string, accountId: string): AgentIdentity | null {
  const file = identityPath(keysDir, network, accountId);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as AgentIdentity;
  return { ...raw, policy: parseSpendPolicy(raw.policy) };
}
