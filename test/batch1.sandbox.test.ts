// AG-023 in near-sandbox: the ten on-chain kinds of batch 1 (catalog 1 to 10) through the templates of the SDK, with the mock NFT, three mock NEP-141 tokens (one with a
// whitelist, the RWA token) and the mock multi-token; plus one invalid listing per group. Run: X207_SANDBOX=1 npx vitest run test/batch1.sandbox.test.ts
// (build probes/mock_nft, mock_rwa and mock_mt first).
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, type ContractCall } from "@x207/core";
// @ts-expect-error script .mjs without types
import { CATALOG, registerCatalog } from "../../scripts/lib/asset-catalog.mjs";
import { SHORT_PARAMS, TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { MOCK_MT_WASM, MOCK_NFT_WASM, MOCK_RWA_WASM, sandboxAvailable, type SandboxAccount } from "../../sdk/test-support/sandbox.ts";
import { BATCH1_KINDS, runBatch1 } from "./batch1-scenario.ts";

const ready = sandboxAvailable && [MOCK_NFT_WASM, MOCK_RWA_WASM, MOCK_MT_WASM].every((p) => existsSync(p));

describe.skipIf(!ready)("AG-023 ten kinds of batch 1 in near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-AG-023-01 each kind is offered, deposited and bought; one invalid listing per group is refused by the template and by the contract", async () => {
    fx = await deployCircle({ ...SHORT_PARAMS, epoch_length: 86_400 });
    const dao = await fx.sandbox.createAccount("dao", "10");
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const chain = (method: string, args: Record<string, unknown>) => fx.sandbox.view(fx.circle.accountId, method, args);
    const registered = await registerCatalog({
      view: chain,
      send: async ({ methodName, args }: { methodName: string; args: Record<string, unknown> }) => {
        const r = await dao.call({ receiverId: fx.circle.accountId, methodName, args, deposit: 0n, gas: 100_000_000_000_000n }, "EXECUTED_OPTIMISTIC");
        if (r.failures.length > 0) throw new Error(r.failures.join("; "));
        return r.hash;
      },
    });
    expect(registered).toMatchObject({ missing: [], wrong: [], total: CATALOG.length });

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

    const deploy = async (name: string, wasm: string): Promise<SandboxAccount> => {
      const account = await fx.sandbox.createAccount(name, "10");
      await fx.sandbox.deploy(account, wasm);
      expect((await account.call({ receiverId: account.accountId, methodName: "new", args: {}, deposit: 0n })).failures).toEqual([]);
      return account;
    };
    const call = async (on: SandboxAccount, methodName: string, args: object) => expect((await on.call({ receiverId: on.accountId, methodName, args, deposit: 0n })).failures).toEqual([]);
    const nft = await deploy("nft", MOCK_NFT_WASM);
    for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) await call(nft, "nft_mint", { token_id: id, owner_id: grantor.account.accountId });
    const tokens = { ft: await deploy("tokft", MOCK_RWA_WASM), rwa: await deploy("tokrwa", MOCK_RWA_WASM), lst: await deploy("toklst", MOCK_RWA_WASM) };
    for (const token of Object.values(tokens)) await call(token, "mint", { account_id: grantor.account.accountId, amount: "100000000" });
    await call(tokens.rwa, "set_whitelist_on", { on: true });
    for (const who of [fx.circle.accountId, grantor.account.accountId, buyer.account.accountId]) await call(tokens.rwa, "set_whitelisted", { account_id: who, whitelisted: true });
    const mt = await deploy("mt", MOCK_MT_WASM);
    await call(mt, "mint", { account_id: grantor.account.accountId, token_id: "nep141:usdt.tether-token.near", amount: "5000000" });
    await call(mt, "mint", { account_id: grantor.account.accountId, token_id: "pool:1", amount: "1000" });

    const accounts = new Map<string, SandboxAccount>([[grantor.account.accountId, grantor.account], [buyer.account.accountId, buyer.account]]);
    const epoch = (await fx.sandbox.view<{ epoch: number }>(fx.circle.accountId, "get_epoch", {})).epoch;
    const steps = await runBatch1({
      circle: fx.circle.accountId, grantor: grantor.account.accountId, buyer: buyer.account.accountId, buyerVoucherKey: buyer.secretKey, epoch,
      nft: nft.accountId, tokens: { ft: tokens.ft.accountId, rwa: tokens.rwa.accountId, lst: tokens.lst.accountId }, mt: mt.accountId,
      send: async (account, c) => {
        const r = await accounts.get(account)!.call({ ...c, deposit: c.deposit ?? 0n }, "FINAL");
        return { failures: r.failures, logs: r.logs, value: r.value };
      },
      view: (contractId, method, args) => fx.sandbox.view(contractId, method, args),
    });

    expect(steps.filter((s) => !s.ok), JSON.stringify(steps.filter((s) => !s.ok))).toEqual([]);
    for (const kind of BATCH1_KINDS) expect(steps.filter((s) => s.kind === kind).map((s) => s.step), kind).toEqual(["offer_grant", "deposit", "complete_escrow"]);
    expect(steps.filter((s) => s.step.includes("refuses")).map((s) => s.kind)).toEqual(["nft-group", "ft-group", "mt-group", "nft-group", "ft-group", "mt-group"]);
    for (const s of steps) console.log(`AG-023 ${s.kind} ${s.step}: ${s.ok ? "ok" : "FAILED"} (${s.detail})`);
  }, 1_500_000);
});
