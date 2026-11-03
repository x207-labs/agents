// AG-020 di near-sandbox: agent pengadaan `gpu` membeli dari agent lain dengan voucher nyata; pembelian di luar batas tidak
// menghasilkan voucher, jadi kewajiban on-chain hanya sebesar pembelian yang disetujui.
import { afterAll, describe, expect, it } from "vitest";
import { ProcurementAgent } from "../scenario/business.ts";
import { AGENTS } from "../shared/registry.ts";
import { createAgentBuyer } from "../shared/x207.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";
import { startStack, type Stack } from "./stack.ts";

describe.skipIf(!sandboxAvailable)("AG-020 procurement on near-sandbox", () => {
  let stack: Stack;
  afterAll(async () => {
    await stack?.stop();
  });

  it("a purchase within limits becomes an on-chain obligation, a purchase outside limits does not", async () => {
    stack = await startStack();
    const { fx, identity, urls } = stack;
    const service = (name: "translator" | "summarizer" | "cleaner", maxPrice: string) => ({ name: AGENTS[name].verb, url: urls[name], path: `/api/${AGENTS[name].verb}`, maxPrice });
    const agent = new ProcurementAgent({
      account: identity.gpu.accountId,
      // harga tiap jasa 20000 (0,02 credit): translate dan clean boleh, summarize dibatasi 10000 (di bawah harga), image tidak terdaftar
      policy: { spend: { maxPerCall: "50000", maxPerEpoch: "60000" }, services: [service("translator", "30000"), service("summarizer", "10000"), service("cleaner", "30000")] },
      pay: createAgentBuyer(identity.gpu, { rpcUrls: [fx.sandbox.rpcUrl] }),
    });

    const results = [
      await agent.buy("translate", "hello"),
      await agent.buy("summarize", "hello"),
      await agent.buy("image", "hello"),
      await agent.buy("clean", "hello"),
      await agent.buy("translate", "hello"),
      await agent.buy("clean", "hello"),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "ok", "price_above_service_limit", "service_not_allowed", "ok", "ok", "over_epoch_budget",
    ]);
    expect(stack.settled).toHaveLength(3);

    expect(await stack.scheduler.tick()).toMatchObject({ registered: 2, dropped: 0, retrying: 0 });
    const epoch = (await fx.sandbox.view<{ epoch: number }>(fx.circle.accountId, "get_epoch", {})).epoch;
    const edge = (creditor: "translator" | "cleaner" | "summarizer") =>
      fx.sandbox.view<{ cumulative: string } | null>(fx.circle.accountId, "obligation", { epoch, debtor: identity.gpu.accountId, creditor: identity[creditor].accountId });
    expect((await edge("translator"))?.cumulative).toBe("40000");
    expect((await edge("cleaner"))?.cumulative).toBe("20000");
    expect(await edge("summarizer")).toBeNull(); // rejected before payment: no voucher, no edge
    expect(agent.spent).toBe(60_000n);
  }, 600_000);
});
