// TC-AG-007-01 di near-sandbox: function-call key agent tidak bisa melampirkan deposit (ADR-11b).
import { afterAll, describe, expect, it } from "vitest";
import { deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";

describe.skipIf(!sandboxAvailable)("AG-007 deposit through a function-call key", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-AG-007-01 ft_transfer_call with a 1 yocto deposit is rejected, without a deposit is accepted", async () => {
    fx = await deployCircle();
    const agent = await fx.member("translator");
    const restricted = await agent.withFunctionCallKey(fx.usdt.accountId);

    const withDeposit = await restricted.call({
      receiverId: fx.usdt.accountId, methodName: "ft_transfer_call",
      args: { receiver_id: fx.circle.accountId, amount: "1000000", msg: '{"action":"stake"}' }, deposit: 1n,
    });
    expect(withDeposit.failures.join(" ")).toMatch(/DepositWithFunctionCall|deposit/i);

    // Kontrol: function call yang sama tanpa deposit lolos pemeriksaan kunci (kontrak USDT yang menolak karena 1 yocto).
    const withoutDeposit = await restricted.call({
      receiverId: fx.usdt.accountId, methodName: "ft_balance_of", args: { account_id: agent.accountId }, deposit: 0n,
    });
    expect(withoutDeposit.failures.join(" ")).not.toMatch(/DepositWithFunctionCall/);
  }, 300_000);
});
