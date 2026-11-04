// TC-AG-009-01..03 on near-sandbox: 300 voucher payments among six agents in one epoch, then close_epoch and the cycle.
import { afterAll, describe, expect, it } from "vitest";
import { createAgentBuyer } from "../shared/x207.ts";
import { AGENT_NAMES, AGENTS } from "../shared/registry.ts";
import { hasCycleThroughAll, planDensePayments } from "../scenario/dense.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";
import { startStack, type Stack } from "./stack.ts";

describe.skipIf(!sandboxAvailable)("AG-009 dense six-agent scenario", () => {
  let stack: Stack;
  afterAll(async () => {
    await stack?.stop();
  });

  it("300 payments succeed, all six agents are buyer and seller, a cycle passes through all six agents after close_epoch", async () => {
    stack = await startStack();
    const { fx, identity, urls } = stack;
    const buyers = Object.fromEntries(AGENT_NAMES.map((n) => [n, createAgentBuyer(identity[n], { rpcUrls: [fx.sandbox.rpcUrl] })]));
    const plan = planDensePayments(300, 20261101);

    let ok = 0;
    for (const { buyer, seller } of plan) {
      const response = await buyers[buyer]!(`${urls[seller]}/api/${AGENTS[seller].verb}?input=hello`);
      if (response.status === 200) ok += 1;
      else throw new Error(`${buyer} -> ${seller}: HTTP ${response.status} ${await response.text()}`);
    }
    expect(ok).toBe(300);
    expect(stack.settled).toHaveLength(300);
    expect(new Set(plan.map((p) => p.buyer)).size).toBe(6);
    expect(new Set(plan.map((p) => p.seller)).size).toBe(6);

    // One registration transaction per pair, far fewer than 300 calls.
    expect(await stack.scheduler.tick()).toMatchObject({ registered: 12, dropped: 0, retrying: 0 });

    const epoch = (await fx.sandbox.view<{ epoch: number; cutoff_at: string }>(fx.circle.accountId, "get_epoch", {}));
    await fx.sandbox.advanceTo(Number(BigInt(epoch.cutoff_at) / 1_000_000n) + 1_000);
    await new Promise((r) => setTimeout(r, 3_000));
    const closer = fx.sandbox.accountFrom(fx.circle.accountId, fx.circle.secretKey);
    const closed = await closer.call({ receiverId: fx.circle.accountId, methodName: "close_epoch", args: { epoch: epoch.epoch }, deposit: 0n }, "EXECUTED_OPTIMISTIC");
    expect(closed.failures).toEqual([]);

    const edges = await fx.sandbox.view<Array<{ debtor: string; creditor: string }>>(fx.circle.accountId, "list_obligations", {
      epoch: epoch.epoch, from_index: 0, limit: 100,
    });
    expect(edges.length).toBeGreaterThanOrEqual(12);
    expect(hasCycleThroughAll(AGENT_NAMES.map((n) => identity[n].accountId), edges)).toBe(true);
  }, 900_000);
});
