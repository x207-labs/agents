import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
  it("TC-AG-004-06 the spend policy is validated and read when the agent starts", () => {
    expect(parseSpendPolicy(POLICY)).toEqual(POLICY);
    expect(() => parseSpendPolicy({ maxPerCall: "0", maxPerEpoch: "1" })).toThrow(/maxPerCall/);
    expect(() => parseSpendPolicy({ maxPerCall: "10", maxPerEpoch: "1" })).toThrow(/must not exceed/);
    const dir = tmp();
    const { secretKey, publicKey } = generateVoucherKeypair();
    saveIdentity(dir, "sandbox", { accountId: "a.test.near", voucherSecretKey: secretKey, voucherPublicKey: publicKey, policy: POLICY });
    expect(statSync(identityPath(dir, "sandbox", "a.test.near")).mode & 0o777).toBe(0o600);
    expect(loadIdentity(dir, "sandbox", "a.test.near")).toMatchObject({ voucherPublicKey: publicKey, policy: POLICY });
    expect(loadIdentity(dir, "sandbox", "b.test.near")).toBeNull();
  });

  it("TC-AG-004-F8 a key file with group or other bits is rejected, an old directory is tightened to 0700 on save (review BE-063)", () => {
    const dir = mkdtempSync(join(tmpdir(), "x207-keys-f8-"));
    dirs.push(dir);
    const { publicKey, secretKey } = generateVoucherKeypair();
    const identity = { accountId: "a.test.near", voucherSecretKey: secretKey, voucherPublicKey: publicKey, policy: POLICY };
    const file = saveIdentity(dir, "sandbox", identity);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o640);
    expect(() => loadIdentity(dir, "sandbox", "a.test.near")).toThrow(/mode 640/);
    chmodSync(file, 0o604);
    expect(() => loadIdentity(dir, "sandbox", "a.test.near")).toThrow(/chmod 600/);
    chmodSync(file, 0o400);
    expect(loadIdentity(dir, "sandbox", "a.test.near")).toMatchObject({ voucherPublicKey: publicKey });
    chmodSync(join(dir, "sandbox"), 0o755);
    chmodSync(file, 0o600);
    saveIdentity(dir, "sandbox", identity);
    expect(statSync(join(dir, "sandbox")).mode & 0o777).toBe(0o700);
  });

  it("six agents: distinct voucher keys, join and stake are sent from the agent account, a rerun sends nothing", async () => {
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

  it("TC-AG-042-01 an active member whose voucher key is not the saved one is refused, not reused (A-AG-17)", async () => {
    const dir = tmp();
    const mine = generateVoucherKeypair();
    const other = generateVoucherKeypair();
    saveIdentity(dir, "sandbox", { accountId: "a.test.near", voucherSecretKey: mine.secretKey, voucherPublicKey: mine.publicKey, policy: POLICY });
    const run = (onChain: string) =>
      onboardAgents({
        agents: [{ accountId: "a.test.near", sendCall: vi.fn() }], circleContract: CIRCLE, circleId: "agents-main", termsHash: "a".repeat(64), stakeAmount: "50000000",
        policy: POLICY, keysDir: dir, network: "sandbox", pollIntervalMs: 1, timeoutMs: 1000,
        view: async (method) => (method === "member" ? { status: "active", stake: "1", limit: "1", pubkey_voucher: onChain } : null),
      });
    await expect(run(other.publicKey)).rejects.toThrow(/another voucher key than the saved one/);
    expect((await run(mine.publicKey)).map((o) => o.status)).toEqual(["already_active"]);
  });

  it("TC-AG-042-02 saving a key leaves no temporary file behind and replaces an older file", () => {
    const dir = tmp();
    const a = generateVoucherKeypair();
    const b = generateVoucherKeypair();
    saveIdentity(dir, "sandbox", { accountId: "a.test.near", voucherSecretKey: a.secretKey, voucherPublicKey: a.publicKey, policy: POLICY });
    const file = saveIdentity(dir, "sandbox", { accountId: "a.test.near", voucherSecretKey: b.secretKey, voucherPublicKey: b.publicKey, policy: POLICY });
    expect(readdirSync(join(dir, "sandbox"))).toEqual(["a.test.near.agent.json"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadIdentity(dir, "sandbox", "a.test.near")).toMatchObject({ voucherPublicKey: b.publicKey });
  });
});
