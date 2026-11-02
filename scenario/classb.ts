// Skenario demo kelas B (AG-015, F8): pemilik menyewakan akses akun NEAR lewat function-call key, penyewa membayar sewa dengan voucher x402 biasa ke broker
// dan menerima key itu, memanggil method yang diizinkan, lalu method lain dan deposit ditolak oleh protokol NEAR sendiri. Saat penyewa `defaulted`
// broker menghapus key. Modul ini hanya memegang peran dan urutan; semua I/O (transaksi, HTTP, kunci akses) disuntik oleh pemanggil, karena agent
// tidak boleh memegang kunci akses akun (AG-007): kunci voucher hanya menandatangani voucher, dan kunci function-call milik penyewa dipakai lewat
// `callWithKey` yang disediakan orkestrasi (demo/classb.demo.ts).
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { base58Encode, type ContractCall } from "@x207/core";

/** Mengirim satu panggilan kontrak dari akun seorang anggota (pemberi atau penyewa) dan mengembalikan nilai suksesnya. */
export type SendCall = (call: ContractCall) => Promise<unknown>;

export const CLASS_B_ASSET_TYPE = "near-rpc:access";
export const CLASS_B_DELIVERY = "near_access_key";
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

export type OfferRental = {
  /** Akun pemberi mengirim `offer_grant`. */
  send: SendCall;
  contract: string;
  scope: string;
  /** Credit satuan terkecil per hari. */
  unitPrice: string;
  /** Akun broker yang menyerahkan key (`operator` grant). */
  operator: string;
  /** Batas akhir grant, milidetik Unix. */
  expiresAtMs: number;
};

/** Pemberi menawarkan sewa harian; mengembalikan `grant_id`. */
export async function offerRental(o: OfferRental): Promise<number> {
  const id = await o.send({
    receiverId: o.contract, methodName: "offer_grant", deposit: 0n,
    args: {
      input: {
        asset_type: CLASS_B_ASSET_TYPE, delivery_method: CLASS_B_DELIVERY,
        limits: { scope: o.scope, quota: null, expires_at: (BigInt(o.expiresAtMs) * 1_000_000n).toString() },
        unit: "day", unit_price: o.unitPrice, operator: o.operator, proof_hash: null, proof_kind: null,
      },
    },
  });
  return Number(id);
}

/** Penyewa menerima grant dengan kunci function-call miliknya sendiri sebagai `delivery_pubkey`; kunci rahasia tetap di penyewa. */
export async function acceptRental(o: { send: SendCall; contract: string; grantId: number; key?: AccessKey }): Promise<AccessKey> {
  const key = o.key ?? newAccessKey();
  await o.send({ receiverId: o.contract, methodName: "accept_grant", args: { grant_id: o.grantId, delivery_pubkey: key.publicKey }, deposit: 0n });
  return key;
}

export type LeaseResult = { status: number; body: Record<string, unknown>; paymentResponse: boolean };

/** Penyewa meminta sewa ke broker lewat `buy` (fetch x402 dengan voucher); 402 dibayar otomatis, hasilnya key yang terpasang sampai `paidUntil`. */
export async function payLease(o: { buy: typeof fetch; brokerUrl: string; grantId: number }): Promise<LeaseResult> {
  const response = await o.buy(`${o.brokerUrl}/grants/${o.grantId}/lease`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, paymentResponse: response.headers.get("PAYMENT-RESPONSE") !== null };
}

/** Hasil satu panggilan dengan function-call key: sukses atau ditolak (pesan galat protokol). */
export type KeyCallOutcome = { ok: true; hash: string } | { ok: false; error: string };
export type CallWithKey = (key: AccessKey, methodName: string, deposit: bigint) => Promise<KeyCallOutcome>;

export type KeyProbe = { allowed: KeyCallOutcome; otherMethod: KeyCallOutcome; withDeposit: KeyCallOutcome };

/** Protokol NEAR sendiri membatasi key: method yang diizinkan jalan, method lain dan deposit ditolak. Tidak ada kode x207 di jalur ini. */
export async function probeKey(call: CallWithKey, key: AccessKey, allowedMethod: string, otherMethod: string): Promise<KeyProbe> {
  return {
    allowed: await call(key, allowedMethod, 0n),
    otherMethod: await call(key, otherMethod, 0n),
    withDeposit: await call(key, allowedMethod, 1n),
  };
}

/** Panggilan terlarang memang gagal dan panggilan sah memang jalan; kalau tidak, skenario gagal. */
export function assertProbe(probe: KeyProbe): void {
  if (!probe.allowed.ok) throw new Error(`panggilan yang diizinkan gagal: ${probe.allowed.error}`);
  if (probe.otherMethod.ok) throw new Error("method di luar daftar seharusnya ditolak");
  if (probe.withDeposit.ok) throw new Error("panggilan dengan deposit seharusnya ditolak");
}

/** Satu hari sewa dalam milidetik, untuk menghitung `expires_at` dan `paidUntil`. */
export const RENTAL_DAY_MS = DAY_MS;
