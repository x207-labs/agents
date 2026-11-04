// Agent x402 owner quickstart (UM-069), step 3: `join` and stake for one agent. The onboarding folder may send transactions; the owner's access key
// is used to sign, and the voucher key is created fresh and returned (AG-007).
import { createNearSender, createNearView } from "@x207/core/signer";
import { onboardMember } from "@x207/core";

export type JoinOptions = {
  rpcUrl: string;
  circleContract: string;
  circleId: string;
  /** The agent NEAR account and its access key (not the voucher key). */
  accountId: string;
  accessKey: `ed25519:${string}`;
  /** sha256 hex of the circle terms you approve. */
  termsHash: string;
  /** USDT stake in smallest units, e.g. "50000000" = 50. */
  stakeAmount: string;
};

/** Step 3: `join` and `stake`, then wait for `active` status. The voucher key is created fresh; store `secretKey` in a secret place. */
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
