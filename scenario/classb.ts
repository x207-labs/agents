// Skenario demo kelas B (AG-015, F8): pemilik menyewakan akses akun NEAR lewat function-call key, penyewa membayar sewa dengan voucher x402 biasa ke broker
// dan menerima key itu, memanggil method yang diizinkan, lalu method lain dan dana terlampir ditolak oleh protokol NEAR sendiri. Saat penyewa `defaulted`
// broker menghapus key. Modul ini hanya memegang peran dan urutan; semua I/O (transaksi, HTTP, kunci akses) disuntik oleh pemanggil, karena agent
// tidak boleh memegang kunci akses akun (AG-007); transaksi pemberi dan penyewa (offer_grant, accept_grant) ada di onboarding/rental.ts: kunci voucher hanya menandatangani voucher, dan kunci function-call milik penyewa dipakai lewat
// `callWithKey` yang disediakan orkestrasi (demo/classb.demo.ts).
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { base58Encode } from "@x207/core";

export const CLASS_B_ASSET_TYPE = "near-rpc:access";
const DAY_MS = 86_400_000;
export const DEFAULT_ALLOWANCE = "1000000000000000000000000";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Kunci akses ed25519 baru dalam format NEAR (`ed25519:<base58>`); kunci rahasia = seed 32 byte + kunci publik. */
export type AccessKey = { publicKey: string; secretKey: string };

export function newAccessKey(seed: Uint8Array = randomBytes(32)): AccessKey {
  const spki = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(spki.subarray(spki.length - 32));
  return { publicKey: `ed25519:${base58Encode(publicKey)}`, secretKey: `ed25519:${base58Encode(Buffer.concat([Buffer.from(seed), Buffer.from(publicKey)]))}` };
}

/** `scope` kelas B (Spec Antarmuka Kontrak 15.1): kunci hanya boleh memanggil `methodNames` di `receiverId`, dengan gas sampai `allowance` yoctoNEAR. */
export function rentalScope(receiverId: string, methodNames: readonly string[], allowance: string = DEFAULT_ALLOWANCE): string {
  return JSON.stringify({ receiver_id: receiverId, method_names: methodNames, allowance });
}

export type LeaseResult = { status: number; body: Record<string, unknown>; paymentResponse: boolean };

/** Penyewa meminta sewa ke broker lewat `buy` (fetch x402 dengan voucher); 402 dibayar otomatis, hasilnya key yang terpasang sampai `paidUntil`. */
export async function payLease(o: { buy: typeof fetch; brokerUrl: string; grantId: number }): Promise<LeaseResult> {
  const response = await o.buy(`${o.brokerUrl}/grants/${o.grantId}/lease`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, paymentResponse: response.headers.get("PAYMENT-RESPONSE") !== null };
}

/** Hasil satu panggilan dengan function-call key: sukses atau ditolak (pesan galat protokol). */
export type KeyCallOutcome = { ok: true; hash: string } | { ok: false; error: string };
/** `attachedYocto` = dana yang dilampirkan ke panggilan; function-call key tidak boleh melampirkannya. */
export type CallWithKey = (key: AccessKey, methodName: string, attachedYocto: bigint) => Promise<KeyCallOutcome>;

export type KeyProbe = { allowed: KeyCallOutcome; otherMethod: KeyCallOutcome; withFunds: KeyCallOutcome };

/** Protokol NEAR sendiri membatasi key: method yang diizinkan jalan, method lain dan dana terlampir ditolak. Tidak ada kode x207 di jalur ini. */
export async function probeKey(call: CallWithKey, key: AccessKey, allowedMethod: string, otherMethod: string): Promise<KeyProbe> {
  return {
    allowed: await call(key, allowedMethod, 0n),
    otherMethod: await call(key, otherMethod, 0n),
    withFunds: await call(key, allowedMethod, 1n),
  };
}

/** Panggilan terlarang memang gagal dan panggilan sah memang jalan; kalau tidak, skenario gagal. */
export function assertProbe(probe: KeyProbe): void {
  if (!probe.allowed.ok) throw new Error(`panggilan yang diizinkan gagal: ${probe.allowed.error}`);
  if (probe.otherMethod.ok) throw new Error("method di luar daftar seharusnya ditolak");
  if (probe.withFunds.ok) throw new Error("panggilan dengan dana terlampir seharusnya ditolak");
}

/** Satu hari sewa dalam milidetik, untuk menghitung `expires_at` dan `paidUntil`. */
export const RENTAL_DAY_MS = DAY_MS;
