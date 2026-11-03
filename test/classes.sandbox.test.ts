// AG-022 in near-sandbox: the real contract with the whole barter catalog in its registry D10 (UM-075), the mock RWA token of `probes/mock_rwa` with a whitelist,
// and one asset of each class A to D plus a refused one (X). Run: X207_SANDBOX=1 npx vitest run test/classes.sandbox.test.ts (build probes/mock_rwa first).
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { createCircleViewFn, onboardMember, type ContractCall } from "@x207/core";
// @ts-expect-error script .mjs without types
import { CATALOG, registerCatalog } from "../../scripts/lib/asset-catalog.mjs";
import { SHORT_PARAMS, TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { MOCK_RWA_WASM, sandboxAvailable, type SandboxAccount } from "../../sdk/test-support/sandbox.ts";
import { runClassScenario, type ClassScenarioPorts } from "./classes-scenario.ts";

describe.skipIf(!sandboxAvailable || !existsSync(MOCK_RWA_WASM))("AG-022 one asset of each class in near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-AG-022-10 A (RWA token with a whitelist), B, C and D reach their end state, X is refused, and the buyer ends with the tokens", async () => {
    // a long epoch: registering the catalog and joining take minutes, and complete_escrow is refused in the last 120 s before the cutoff
    fx = await deployCircle({ ...SHORT_PARAMS, epoch_length: 86_400 });
    const dao = await fx.sandbox.createAccount("dao", "10");
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const chain = (method: string, args: Record<string, unknown>) => fx.sandbox.view(fx.circle.accountId, method, args);

    // the registry: the whole catalog, through the same function as the script
    const registered = await registerCatalog({
      view: chain,
      send: async ({ methodName, args }: { methodName: string; args: object }) => {
        const r = await dao.call({ receiverId: fx.circle.accountId, methodName, args, deposit: 0n, gas: 100_000_000_000_000n }, "EXECUTED_OPTIMISTIC");
        if (r.failures.length > 0) throw new Error(r.failures.join("; "));
        return r.hash;
      },
    });
    expect(registered).toMatchObject({ missing: [], wrong: [], total: CATALOG.length });

    // members and the token
    const join = async (name: string) => {
      const account = await fx.member(name);
      const joined = await onboardMember(
        { sendCall: async (c: ContractCall) => { const r = await account.call(c); if (r.failures.length > 0) throw new Error(r.failures.join("; ")); return r.value; }, view, pollIntervalMs: 200, timeoutMs: 60_000 },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, secretKey: joined.secretKey };
    };
    const grantor = await join("grantor");
    const buyer = await join("buyer");
    const token = await fx.sandbox.createAccount("rwa", "10");
    await fx.sandbox.deploy(token, MOCK_RWA_WASM);
    expect((await token.call({ receiverId: token.accountId, methodName: "new", args: {}, deposit: 0n })).failures).toEqual([]);
    expect((await token.call({ receiverId: token.accountId, methodName: "mint", args: { account_id: grantor.account.accountId, amount: "5000" }, deposit: 0n })).failures).toEqual([]);

    const accounts = new Map<string, SandboxAccount>([[grantor.account.accountId, grantor.account], [buyer.account.accountId, buyer.account], [dao.accountId, dao]]);
    const ports: ClassScenarioPorts = {
      send: async (account, call) => {
        const r = await accounts.get(account)!.call({ ...call, deposit: call.deposit ?? 0n }, "FINAL"); // the deposit and the delivery have callbacks: wait for all receipts
        return { failures: r.failures, logs: r.logs, value: r.value };
      },
      view: (contractId, method, args) => fx.sandbox.view(contractId, method, args),
    };
    const epoch = (await fx.sandbox.view<{ epoch: number }>(fx.circle.accountId, "get_epoch", {})).epoch;
    const steps = await runClassScenario(ports, {
      circle: fx.circle.accountId, token: token.accountId, grantor: grantor.account.accountId, buyer: buyer.account.accountId,
      buyerVoucherKey: buyer.secretKey, deliveryPubkey: KeyPair.fromRandom("ed25519").getPublicKey().toString(), epoch,
    });

    expect(steps.filter((s) => !s.ok), JSON.stringify(steps.filter((s) => !s.ok))).toEqual([]);
    expect(new Set(steps.map((s) => s.assetClass))).toEqual(new Set(["A", "B", "C", "D", "X"]));
    // the buyer holds the tokens and the circle holds none
    expect(await fx.sandbox.view(token.accountId, "ft_balance_of", { account_id: buyer.account.accountId })).toBe("1000");
    expect(await fx.sandbox.view(token.accountId, "ft_balance_of", { account_id: fx.circle.accountId })).toBe("0");
    for (const s of steps) console.log(`AG-022 ${s.assetClass} ${s.assetType} ${s.step}: ${s.ok ? "ok" : "FAILED"} (${s.detail})`);
  }, 900_000);
});
