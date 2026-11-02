// Quickstart pemilik agent x402 (UM-069), langkah 3: `join` dan stake untuk satu agent. Folder onboarding boleh mengirim transaksi; kunci akses
// pemilik dipakai untuk menandatangani, kunci voucher dibuat baru dan dikembalikan (AG-007).
import { createNearSender, createNearView } from "@x207/core/signer";
import { onboardMember } from "@x207/core";

export type JoinOptions = {
  rpcUrl: string;
  circleContract: string;
  circleId: string;
  /** Akun NEAR agent dan kunci aksesnya (bukan kunci voucher). */
  accountId: string;
  accessKey: `ed25519:${string}`;
  /** sha256 hex syarat lingkaran yang Anda setujui. */
  termsHash: string;
  /** Stake USDT dalam satuan terkecil, mis. "50000000" = 50. */
  stakeAmount: string;
};

/** Langkah 3: `join` dan `stake`, lalu tunggu status `active`. Kunci voucher dibuat baru; simpan `secretKey` di tempat rahasia. */
export async function joinCircle(options: JoinOptions) {
  return onboardMember(
    {
      sendCall: createNearSender({ rpcUrl: options.rpcUrl, accountId: options.accountId, secretKey: options.accessKey }),
      view: createNearView(options.rpcUrl, options.circleContract),
    },
    {
      circleContract: options.circleContract, circleId: options.circleId, accountId: options.accountId,
      termsHash: options.termsHash, stakeAmount: options.stakeAmount,
    },
  );
}
