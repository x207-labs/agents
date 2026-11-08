// Agent onboarding (AG-004, F1): one ed25519 voucher key per agent, then `join` and stake through
// `onboardMember` from @x207/core, signed by the account owner's key (not the voucher key).
import {
  buildStakeTransferCall, generateVoucherKeypair, getMember, onboardMember, OnboardTimeoutError, StakeRejectedError, voucherPublicKey, type CircleViewFn, type ContractCall,
} from "@x207/core";
import { loadIdentity, saveIdentity, type AgentIdentity, type SpendPolicy } from "../shared/identity.ts";

export type AgentTarget = {
  accountId: string;
  /** Sends a transaction from the agent account, signed by that account owner's key. */
  sendCall: (call: ContractCall) => Promise<unknown>;
};

export type OnboardOptions = {
  agents: readonly AgentTarget[];
  circleContract: string;
  circleId: string;
  /** Lowercase sha256 hex of the circle terms approved by the owner. */
  termsHash: string;
  /** Stake per agent in USDT smallest units. */
  stakeAmount: string;
  policy: SpendPolicy;
  view: CircleViewFn;
  keysDir: string;
  network: string;
  usdtTokenId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type OnboardOutcome = { identity: AgentIdentity; status: "onboarded" | "already_active" };

/** Idempotent: an agent that is already `active` is skipped and its identity is reused. */
export async function onboardAgents(options: OnboardOptions): Promise<OnboardOutcome[]> {
  const log = options.log ?? (() => {});
  const outcomes: OnboardOutcome[] = [];
  for (const agent of options.agents) {
    const stored = loadIdentity(options.keysDir, options.network, agent.accountId);
    const member = (await options.view("member", { account_id: agent.accountId })) as { status: string; pubkey_voucher?: string } | null;
    if (member?.status === "active" && stored) {
      log(`${agent.accountId}: already active`);
      outcomes.push({ identity: stored, status: "already_active" });
      continue;
    }
    const deps = {
      sendCall: agent.sendCall,
      view: options.view,
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    };

    // A-AG-05: a member that joined but never became active (a crash between `join` and the end) is resumed from the key that was saved BEFORE the join; without that key it cannot be
    if (member) {
      const resumable = member.status === "pending" && stored !== null && member.pubkey_voucher === stored.voucherPublicKey;
      if (!resumable) {
        throw new Error(
          `${agent.accountId} is already registered with status ${member.status}${stored ? "" : " and no key is saved for it"}${member.pubkey_voucher && stored && member.pubkey_voucher !== stored.voucherPublicKey ? ", with another key than the saved one" : ""}; onboarding cannot be restarted from scratch`,
        );
      }
      log(`${agent.accountId}: pending with the saved key, sending the stake`);
      const used = await agent.sendCall(
        buildStakeTransferCall({
          circleContract: options.circleContract, amount: options.stakeAmount, memberId: agent.accountId,
          ...(options.usdtTokenId ? { usdtTokenId: options.usdtTokenId } : {}),
        }),
      );
      if (typeof used === "string" && /^\d+$/.test(used) && BigInt(used) < BigInt(options.stakeAmount)) throw new StakeRejectedError(used, options.stakeAmount);
      const deadline = Date.now() + (options.timeoutMs ?? 60_000);
      for (;;) {
        const now = await getMember(options.view, agent.accountId);
        if (now?.status === "active") {
          log(`${agent.accountId}: active, limit ${now.limit}`);
          break;
        }
        if (Date.now() >= deadline) throw new OnboardTimeoutError(now?.status ?? null, options.timeoutMs ?? 60_000);
        await new Promise<void>((r) => setTimeout(r, options.pollIntervalMs ?? 1000));
      }
      outcomes.push({ identity: stored!, status: "onboarded" });
      continue;
    }

    // The key is made and written (mode 0600) first, then the pubkey is registered: a failure after `join` leaves a key on disk that matches the member.
    const keys = stored ? { secretKey: stored.voucherSecretKey } : generateVoucherKeypair();
    const identity: AgentIdentity = stored ?? {
      accountId: agent.accountId,
      voucherSecretKey: keys.secretKey,
      voucherPublicKey: voucherPublicKey(keys.secretKey),
      policy: options.policy,
    };
    if (!stored) saveIdentity(options.keysDir, options.network, identity);
    const result = await onboardMember(deps, {
      circleContract: options.circleContract,
      circleId: options.circleId,
      accountId: agent.accountId,
      termsHash: options.termsHash,
      stakeAmount: options.stakeAmount,
      secretKey: identity.voucherSecretKey,
      ...(options.usdtTokenId ? { usdtTokenId: options.usdtTokenId } : {}),
    });
    log(`${agent.accountId}: active, limit ${result.member.limit}`);
    outcomes.push({ identity, status: "onboarded" });
  }
  return outcomes;
}
