// TC-AG-004-01..05 di near-sandbox, dijalankan dengan X207_SANDBOX=1 (harness di sdk/test-support).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, type ContractCall } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";
import { onboardAgents } from "../onboarding/onboard.ts";
import { loadIdentity } from "../shared/identity.ts";
import { AGENT_NAMES } from "../shared/registry.ts";

describe.skipIf(!sandboxAvailable)("AG-004 enam agent di near-sandbox", () => {
  let fx: CircleFixture;
  const keysDir = mkdtempSync(join(tmpdir(), "x207-agents-keys-"));
  afterAll(async () => {
    rmSync(keysDir, { recursive: true, force: true });
    await fx?.stop();
  });

  it("TC-AG-004-01..05 enam agent active, kunci voucher terpisah dan bukan access key", async () => {
    fx = await deployCircle();
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const accounts = await Promise.all(AGENT_NAMES.map((name) => fx.member(name)));
    const signedBy: Array<{ account: string; method: string }> = [];
    const outcomes = await onboardAgents({
      agents: accounts.map((account) => ({
        accountId: account.accountId,
        sendCall: async (call: ContractCall) => {
          signedBy.push({ account: account.accountId, method: call.methodName });
          const result = await account.call(call);
          if (result.failures.length > 0) throw new Error(result.failures.join("; "));
          return result.value;
        },
      })),
      circleContract: fx.circle.accountId, circleId: fx.circleId, termsHash: TERMS_HASH, stakeAmount: "50000000",
      policy: { maxPerCall: "100000", maxPerEpoch: "50000000" }, view, keysDir, network: "sandbox",
      usdtTokenId: fx.usdt.accountId, pollIntervalMs: 200, timeoutMs: 30_000,
    });

    // 01: enam pubkey berbeda
    const pubkeys = outcomes.map((o) => o.identity.voucherPublicKey);
    expect(new Set(pubkeys).size).toBe(6);
    for (const [i, { identity }] of outcomes.entries()) {
      const member = (await fx.sandbox.view<{ status: string; limit: string; stake: string; pubkey_voucher: string }>(
        fx.circle.accountId, "member", { account_id: identity.accountId },
      ))!;
      // 02: active, limit > 0 dan <= stake
      expect(member.status).toBe("active");
      expect(BigInt(member.limit)).toBeGreaterThan(0n);
      expect(BigInt(member.limit)).toBeLessThanOrEqual(BigInt(member.stake));
      // 03: pubkey di kontrak = pubkey kunci lokal
      expect(member.pubkey_voucher).toBe(pubkeys[i]);
      // 04: pubkey voucher bukan access key akun
      const keys = await fx.sandbox.provider.viewAccessKeyList({ accountId: identity.accountId });
      expect(keys.keys.map((k) => k.public_key)).not.toContain(pubkeys[i]);
      // 06: kebijakan tersimpan dan terbaca ulang
      expect(loadIdentity(keysDir, "sandbox", identity.accountId)?.policy).toEqual({ maxPerCall: "100000", maxPerEpoch: "50000000" });
    }
    // 05: join dan stake dikirim dari akun agent masing-masing
    for (const { identity } of outcomes) {
      expect(signedBy.filter((s) => s.account === identity.accountId).map((s) => s.method)).toEqual(["join", "ft_transfer_call"]);
    }
  }, 300_000);
});
