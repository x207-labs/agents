import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJoinCall, generateVoucherKeypair, type ContractCall } from "@x207/core";
import { identityPath, loadIdentity, parseSpendPolicy, saveIdentity } from "../shared/identity.ts";
import { onboardAgents } from "../onboarding/onboard.ts";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "x207-agents-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const POLICY = { maxPerCall: "100000", maxPerEpoch: "50000000" };
const CIRCLE = "x207-circle.test.near";

describe("AG-004 onboarding", () => {
  it("TC-AG-004-06 kebijakan belanja divalidasi dan terbaca saat agent mulai", () => {
    expect(parseSpendPolicy(POLICY)).toEqual(POLICY);
    expect(() => parseSpendPolicy({ maxPerCall: "0", maxPerEpoch: "1" })).toThrow(/maxPerCall/);
    expect(() => parseSpendPolicy({ maxPerCall: "10", maxPerEpoch: "1" })).toThrow(/tidak boleh melebihi/);
    const dir = tmp();
    const { secretKey, publicKey } = generateVoucherKeypair();
    saveIdentity(dir, "sandbox", { accountId: "a.test.near", voucherSecretKey: secretKey, voucherPublicKey: publicKey, policy: POLICY });
    expect(statSync(identityPath(dir, "sandbox", "a.test.near")).mode & 0o777).toBe(0o600);
    expect(loadIdentity(dir, "sandbox", "a.test.near")).toMatchObject({ voucherPublicKey: publicKey, policy: POLICY });
    expect(loadIdentity(dir, "sandbox", "b.test.near")).toBeNull();
  });

  it("enam agent: kunci voucher berbeda, join dan stake dikirim dari akun agent, ulang tidak mengirim apa pun", async () => {
    const dir = tmp();
    const members = new Map<string, { status: string; stake: string; limit: string; pubkey_voucher: string }>();
    const sent: Array<{ account: string; call: ContractCall }> = [];
    const names = ["translator", "summarizer", "scraper", "image", "cleaner", "gpu"];
    const agents = names.map((n) => {
      const accountId = `${n}.${CIRCLE}`;
      return {
        accountId,
        sendCall: vi.fn(async (call: ContractCall) => {
          sent.push({ account: accountId, call });
          if (call.methodName === "join") {
            members.set(accountId, { status: "pending", stake: "0", limit: "0", pubkey_voucher: String(call.args.pubkey_voucher) });
          } else {
            const m = members.get(accountId)!;
            members.set(accountId, { ...m, status: "active", stake: "50000000", limit: "40000000" });
            return "50000000";
          }
          return undefined;
        }),
      };
    });
    const run = () =>
      onboardAgents({
        agents, circleContract: CIRCLE, circleId: "agents-main", termsHash: "a".repeat(64), stakeAmount: "50000000",
        policy: POLICY, keysDir: dir, network: "sandbox", pollIntervalMs: 1, timeoutMs: 1000,
        view: async (method, args) => (method === "member" ? (members.get((args as { account_id: string }).account_id) ?? null) : null),
      });
    const first = await run();
    expect(first.map((o) => o.status)).toEqual(Array(6).fill("onboarded"));
    expect(new Set(first.map((o) => o.identity.voucherPublicKey)).size).toBe(6);
    expect(sent.filter((s) => s.call.methodName === "join")).toHaveLength(6);
    for (const { identity } of first) {
      const join = sent.find((s) => s.account === identity.accountId && s.call.methodName === "join")!;
      expect(join.call.args.pubkey_voucher).toBe(identity.voucherPublicKey);
      const stake = sent.find((s) => s.account === identity.accountId && s.call.methodName === "ft_transfer_call")!;
      expect(JSON.parse(String(stake.call.args.msg))).toMatchObject({ action: "stake" });
    }
    sent.length = 0;
    const again = await run();
    expect(again.map((o) => o.status)).toEqual(Array(6).fill("already_active"));
    expect(sent).toHaveLength(0);
    void buildJoinCall;
  });
});
