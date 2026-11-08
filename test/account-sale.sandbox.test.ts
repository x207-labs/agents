// AG-050 in near-sandbox (P1, contract 0.0.18): the sale of a NEAR account through the locker, items #11 and #14, with the SDK pre-pay check of SD-119 in front of every payment.
// Needs the 0.0.18 circle wasm (`cargo near build non-reproducible-wasm` on the branch p1-0.0.18 of contracts) and the locker wasm (`... --manifest-path locker/Cargo.toml`), and the
// SD-119 build of @x207/core. Run: X207_SANDBOX=1 npx vitest run test/account-sale.sandbox.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as core from "@x207/core";
import { createCircleViewFn, onboardMember, type ContractCall } from "@x207/core";
import { SHORT_PARAMS, TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { sandboxAvailable, type SandboxAccount } from "../../sdk/test-support/sandbox.ts";
import { lockerCodeHash, prepareRegistry, runMemberAccountSale, runNamedAccountSale, type AccountSaleWorld } from "./account-sale-scenario.ts";

const LOCKER_WASM = fileURLToPath(new URL("../../contracts/target/near/x207_locker/x207_locker.wasm", import.meta.url));
const ready = sandboxAvailable && existsSync(LOCKER_WASM) && typeof (core as Record<string, unknown>).checkAccountLockBeforePay === "function";
// the harness of the SDK uses its own near-api-js; take the same one for the actions of the lock
const nearApi = createRequire(fileURLToPath(new URL("../../sdk/test-support/sandbox.ts", import.meta.url)))("near-api-js") as {
  actions: { deployContract(code: Uint8Array): unknown; functionCall(method: string, args: object, gas: bigint, deposit: bigint): unknown; deleteKey(key: unknown): unknown };
  KeyPair: { fromRandom(kind: string): { toString(): string; getPublicKey(): { toString(): string } } };
  PublicKey: { from(key: string): unknown };
};

describe.skipIf(!ready)("AG-050 sale of a NEAR account in near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-AG-050-01 #11 a named account and #14 a member account: the check refuses an unlocked account, the sale delivers the only key, the member waits one epoch and gets the voucher key", async () => {
    // an epoch long enough for joining and the sale of #11 (a payment is refused in the last 120 s before the cutoff), short enough to fast-forward in 500-block steps
    fx = await deployCircle({ ...SHORT_PARAMS, epoch_length: 1_800 });
    const sandbox = fx.sandbox;
    const dao = await sandbox.createAccount("dao", "10");
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [sandbox.rpcUrl] });
    const join = async (name: string) => {
      const account = await fx.member(name);
      const joined = await onboardMember(
        { sendCall: async (c: ContractCall) => { const r = await account.call(c); if (r.failures.length > 0) throw new Error(r.failures.join("; ")); return r.value; }, view, pollIntervalMs: 200, timeoutMs: 60_000 },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, secretKey: joined.secretKey as `ed25519:${string}` };
    };
    const seller = await join("seller");
    const buyer = await join("buyer");
    const shop = await sandbox.createAccount("shop", "10");
    const eve = await join("eve"); // a member that is sold (#14)

    const wasm = readFileSync(LOCKER_WASM);
    const accounts = new Map<string, SandboxAccount>([[seller.account.accountId, seller.account], [buyer.account.accountId, buyer.account], [dao.accountId, dao]]);
    const rpc = async (params: object): Promise<any> => {
      const r = await fetch(sandbox.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "query", params }) });
      return ((await r.json()) as { result: unknown }).result;
    };
    const keysOf = async (id: string): Promise<string[]> => ((await rpc({ request_type: "view_access_key_list", finality: "optimistic", account_id: id })) as { keys: Array<{ public_key: string }> }).keys.map((k) => k.public_key);

    const world = (sold: SandboxAccount): AccountSaleWorld => {
      const delivery = nearApi.KeyPair.fromRandom("ed25519").getPublicKey().toString();
      const returnKey = nearApi.KeyPair.fromRandom("ed25519").getPublicKey().toString();
      return {
        circle: fx.circle.accountId, seller: seller.account.accountId, buyer: buyer.account.accountId, buyerVoucherKey: buyer.secretKey,
        sold: sold.accountId, returnKey, deliveryKey: delivery, rpcUrl: sandbox.rpcUrl,
        send: async (account, call) => {
          const r = await accounts.get(account)!.call({ ...call, deposit: call.deposit ?? 0n }, "FINAL"); // the delivery has callbacks: wait for all receipts
          return { failures: r.failures, logs: r.logs, value: r.value };
        },
        view: (contractId, method, args) => sandbox.view(contractId, method, args),
        nowNs: async () => BigInt(await sandbox.blockTimestampMs()) * 1_000_000n,
        lock: async (grantId, rk) => {
          const old = await keysOf(sold.accountId);
          const actions = [
            nearApi.actions.deployContract(wasm),
            nearApi.actions.functionCall("new", { circle: fx.circle.accountId, grant_id: grantId, return_pubkey: rk }, 100_000_000_000_000n, 0n),
            ...old.map((k) => nearApi.actions.deleteKey(nearApi.PublicKey.from(k))),
          ];
          try {
            const raw = (await (sold.account as unknown as { signAndSendTransaction(t: object): Promise<{ receipts_outcome: Array<{ outcome: { status: unknown } }> }> }).signAndSendTransaction({ receiverId: sold.accountId, actions })) as { receipts_outcome: Array<{ outcome: { status: unknown } }> };
            const failed = raw.receipts_outcome.filter((o) => typeof o.outcome.status === "object" && o.outcome.status !== null && "Failure" in (o.outcome.status as object));
            return { failures: failed.map((o) => JSON.stringify(o.outcome.status)) };
          } catch (error) {
            return { failures: [(error as Error).message] };
          }
        },
        keysOf,
        nextEpoch: async () => {
          const keeper = sandbox.accountFrom(fx.circle.accountId, fx.circle.secretKey);
          // without an argument get_epoch is the open epoch; once it is closed the next one is open, so the closing one is read by its number
          const epochOf = async (n?: number) => (await sandbox.view(fx.circle.accountId, "get_epoch", n === undefined ? {} : { epoch: n })) as { epoch: number; cutoff_at: string; proposal_deadline?: string; payment_deadline?: string };
          const step = async (method: string, at: string | undefined, epoch: number) => {
            if (at !== undefined) await sandbox.advanceTo(Number(BigInt(at) / 1_000_000n) + 1_000);
            await new Promise((r) => setTimeout(r, 2_000));
            const r = await keeper.sandbox.accountFrom(fx.circle.accountId, fx.circle.secretKey).call({ receiverId: fx.circle.accountId, methodName: method, args: { epoch }, deposit: 0n, gas: 200_000_000_000_000n }, "FINAL");
            if (r.failures.length > 0) throw new Error(`${method}: ${r.failures.join("; ")}`);
          };
          const e = await epochOf();
          await step("close_epoch", e.cutoff_at, e.epoch);
          await step("commit_epoch", (await epochOf(e.epoch)).proposal_deadline, e.epoch);
          await step("finalize_epoch", (await epochOf(e.epoch)).payment_deadline, e.epoch);
        },
      };
    };

    // the official hash of the locker is what the chain shows as the code hash of a locked account
    await prepareRegistry({ circle: fx.circle.accountId, send: async (account, call) => { const r = await dao.call({ ...call, deposit: call.deposit ?? 0n }, "FINAL"); return { failures: r.failures, logs: r.logs, value: r.value }; } }, dao.accountId, lockerCodeHash(wasm));

    const named = await runNamedAccountSale(world(shop));
    for (const s of named) expect(s, `#11 ${s.step}: ${s.detail}`).toMatchObject({ ok: true });
    const member = await runMemberAccountSale(world(eve.account));
    for (const s of member) expect(s, `#14 ${s.step}: ${s.detail}`).toMatchObject({ ok: true });
  }, 1_800_000);
});
