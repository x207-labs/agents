// Onboarding agent (AG-004, F1): satu kunci voucher ed25519 per agent, lalu `join` dan stake lewat
// `onboardMember` dari @x207/core, ditandatangani kunci pemilik akun (bukan kunci voucher).
import { onboardMember, voucherPublicKey, type CircleViewFn, type ContractCall } from "@x207/core";
import { loadIdentity, saveIdentity, type AgentIdentity, type SpendPolicy } from "../shared/identity.ts";

export type AgentTarget = {
  accountId: string;
  /** Mengirim transaksi dari akun agent, ditandatangani kunci pemilik akun itu. */
  sendCall: (call: ContractCall) => Promise<unknown>;
};

export type OnboardOptions = {
  agents: readonly AgentTarget[];
  circleContract: string;
  circleId: string;
  /** sha256 hex huruf kecil dari syarat lingkaran yang disetujui pemilik. */
  termsHash: string;
  /** Stake per agent dalam satuan terkecil USDT. */
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

/** Idempoten: agent yang sudah `active` dilewati dan identitasnya dipakai ulang. */
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
