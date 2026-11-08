import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContractCall } from "@x207/core";
import { loadIdentity } from "../shared/identity.ts";
import { onboardAgents } from "../onboarding/onboard.ts";

// AG-039 (A-AG-05): the key is on disk before the pubkey is registered, so a crash after `join` does not lose the secret, and a re-run resumes with the stake.
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const POLICY = { maxPerCall: "100000", maxPerEpoch: "50000000" };
const CIRCLE = "x207-circle.test.near";
const ACCOUNT = `translator.${CIRCLE}`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "x207-onboard-resume-"));
  dirs.push(dir);
  const state: { member: { status: string; stake: string; limit: string; pubkey_voucher: string } | null; sent: string[]; failStake: boolean } = { member: null, sent: [], failStake: true };
  const sendCall = async (call: ContractCall) => {
    state.sent.push(call.methodName);
    if (call.methodName === "join") {
      state.member = { status: "pending", stake: "0", limit: "0", pubkey_voucher: String(call.args.pubkey_voucher) };
      return undefined;
    }
    if (state.failStake) throw new Error("rpc down during the stake");
    state.member = { ...state.member!, status: "active", stake: "50000000", limit: "40000000" };
    return "50000000";
  };
  const run = () =>
    onboardAgents({
      agents: [{ accountId: ACCOUNT, sendCall }], circleContract: CIRCLE, circleId: "agents-main", termsHash: "a".repeat(64), stakeAmount: "50000000",
      policy: POLICY, keysDir: dir, network: "sandbox", pollIntervalMs: 1, timeoutMs: 1000,
      view: async (method) => (method === "member" ? state.member : null),
    });
  return { dir, state, run };
}

describe("AG-039 onboarding keeps the key from the first moment", () => {
  it("TC-AG-039-01 a failure after join leaves the saved key that matches the registered pubkey", async () => {
    const { dir, state, run } = setup();
    await expect(run()).rejects.toThrow(/rpc down/);
    expect(state.sent).toEqual(["join", "ft_transfer_call"]);
    const saved = loadIdentity(dir, "sandbox", ACCOUNT);
    expect(saved).not.toBeNull();
    expect(saved!.voucherPublicKey).toBe(state.member!.pubkey_voucher);
  });

  it("TC-AG-039-02 a re-run resumes: no second join, the stake is sent, the same key is used", async () => {
    const { dir, state, run } = setup();
    await expect(run()).rejects.toThrow(/rpc down/);
    const key = loadIdentity(dir, "sandbox", ACCOUNT)!.voucherPublicKey;
    state.failStake = false;
    state.sent.length = 0;
    const [outcome] = await run();
    expect(outcome).toMatchObject({ status: "onboarded" });
    expect(outcome!.identity.voucherPublicKey).toBe(key);
    expect(state.sent).toEqual(["ft_transfer_call"]);
    expect(state.member!.status).toBe("active");
  });

  it("TC-AG-039-03 a pending member with another key than the saved one, or with no saved key, is refused (nothing is sent)", async () => {
    const { state, run } = setup();
    state.member = { status: "pending", stake: "0", limit: "0", pubkey_voucher: "ed25519:other" };
    await expect(run()).rejects.toThrow(/no key is saved/);
    expect(state.sent).toEqual([]);
  });
});
