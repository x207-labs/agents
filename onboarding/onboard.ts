// Agent onboarding (AG-004, F1): one ed25519 voucher key per agent, then `join` and stake through
// `onboardMember` from @x207/core, signed by the account owner's key (not the voucher key).
import { onboardMember, voucherPublicKey, type CircleViewFn, type ContractCall } from "@x207/core";
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
    const member = (await options.view("member", { account_id: agent.accountId })) as { status: string } | null;
    if (member?.status === "active" && stored) {
      log(`${agent.accountId}: already active`);
      outcomes.push({ identity: stored, status: "already_active" });
      continue;
    }
    if (member) throw new Error(`${agent.accountId} is already registered with status ${member.status}; onboarding cannot be restarted from scratch`);

    const result = await onboardMember(
      {
        sendCall: agent.sendCall,
        view: options.view,
        ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
      {
        circleContract: options.circleContract,
        circleId: options.circleId,
        accountId: agent.accountId,
        termsHash: options.termsHash,
        stakeAmount: options.stakeAmount,
        ...(options.usdtTokenId ? { usdtTokenId: options.usdtTokenId } : {}),
      },
    );
    const identity: AgentIdentity = {
      accountId: agent.accountId,
      voucherSecretKey: result.secretKey,
      voucherPublicKey: voucherPublicKey(result.secretKey),
      policy: options.policy,
    };
    saveIdentity(options.keysDir, options.network, identity);
    log(`${agent.accountId}: active, limit ${result.member.limit}`);
    outcomes.push({ identity, status: "onboarded" });
  }
  return outcomes;
}
