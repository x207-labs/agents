// AG-008 on near-sandbox: the owner spend policy becomes the client guard. A call that crosses the limit is rejected before the voucher
// is signed, so it never reaches the facilitator and there is no on-chain obligation, even though the contract headroom is still enough.
import { afterAll, describe, expect, it } from "vitest";
import { AGENTS } from "../shared/registry.ts";
import { createAgentBuyer } from "../shared/x207.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";
import { startStack, type Stack } from "./stack.ts";

describe.skipIf(!sandboxAvailable)("AG-008 client-side spend fence", () => {
  let stack: Stack;
  afterAll(async () => {
    await stack?.stop();
  });

  it("TC-AG-008-01 the third purchase over the epoch budget is rejected by the client; the contract sees only two payments", async () => {
    stack = await startStack();
    const { fx, identity, urls } = stack;
    // on-chain limit 40 credit, but the owner caps 0.04 per epoch and 0.02 per call
    const policy = { maxPerCall: "20000", maxPerEpoch: "40000" };
    const buyer = createAgentBuyer({ ...identity.gpu, policy }, { rpcUrls: [fx.sandbox.rpcUrl] });
    const call = (seller: "translator" | "summarizer" | "cleaner") => buyer(`${urls[seller]}/api/${AGENTS[seller].verb}?input=hello`);

    expect((await call("translator")).status).toBe(200);
    expect((await call("summarizer")).status).toBe(200);
    const refused = await call("cleaner").then(() => null, (e: unknown) => e);
    // x402Client wraps the scheme error; the spend limit message is still carried
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/40000.*20000.*40000/);
    expect(stack.settled).toHaveLength(2);

    expect(await stack.scheduler.tick()).toMatchObject({ registered: 2, dropped: 0, retrying: 0 });
    const epoch = (await fx.sandbox.view<{ epoch: number }>(fx.circle.accountId, "get_epoch", {})).epoch;
    const edge = (creditor: "translator" | "summarizer" | "cleaner") =>
      fx.sandbox.view<{ cumulative: string } | null>(fx.circle.accountId, "obligation", { epoch, debtor: identity.gpu.accountId, creditor: identity[creditor].accountId });
    expect((await edge("translator"))?.cumulative).toBe("20000");
    expect((await edge("summarizer"))?.cumulative).toBe("20000");
    expect(await edge("cleaner")).toBeNull();
    const headroom = BigInt(await fx.sandbox.view<string>(fx.circle.accountId, "headroom", { account_id: identity.gpu.accountId }));
    expect(headroom).toBeGreaterThan(30_000_000n); // the contract still allows far more
  }, 600_000);
});
