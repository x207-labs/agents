// Transaksi pemberi dan penyewa untuk skenario kelas B (AG-015): `offer_grant` oleh pemberi dan `accept_grant` oleh penyewa, ditandatangani akun
// pemilik masing-masing lewat `send` yang disuntik (seperti onboarding). Tanpa dana terlampir: kedua method gratis. Modul ini di folder onboarding karena
// folder scenario tidak boleh mengirim transaksi (AG-007).
import type { ContractCall } from "@x207/core";
import { CLASS_B_ASSET_TYPE, newAccessKey, type AccessKey } from "../scenario/classb.ts";

/** Mengirim satu panggilan kontrak dari akun seorang anggota (pemberi atau penyewa) dan mengembalikan nilai suksesnya. */
export type SendCall = (call: ContractCall) => Promise<unknown>;

export const CLASS_B_DELIVERY = "near_access_key";

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

