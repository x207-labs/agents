import { afterEach, describe, expect, it } from "vitest";
import { ASSET_PAIRS, runAssetScenario } from "../scenario/assets.ts";
import { AGENT_NAMES } from "../shared/registry.ts";
import { BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const NOW = Math.floor(Date.parse("2026-11-04T10:00:00Z") / 1000);

describe("AG-019 varied assets", () => {
  it("pairs cover compute, data, access and native assets; classes A, B, C, D are all used", () => {
    const types = ASSET_PAIRS.flatMap((p) => [p.sold.assetType, p.paid.assetType]);
    expect(types.filter((t) => t.startsWith("compute:")).length).toBeGreaterThan(0);
    expect(types.filter((t) => t.startsWith("data:")).length).toBeGreaterThan(0);
    expect(types.filter((t) => t.startsWith("access:")).length).toBeGreaterThan(0);
    expect(new Set(ASSET_PAIRS.flatMap((p) => [p.sold.assetClass, p.paid.assetClass]))).toEqual(new Set(["A", "B", "C", "D"]));
    const agents = ASSET_PAIRS.flatMap((p) => [p.seller, p.buyer]);
    expect(new Set(agents).size).toBe(agents.length);
    for (const name of agents) expect(AGENT_NAMES).toContain(name);
  });
});

describe.skipIf(!BACKEND_AVAILABLE)("AG-019 varied asset scenario on the marketplace book", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-019-01 every pair is matched into a signed bundle, class X is rejected", async () => {
    market = await startMarketBook(AGENT_NAMES, { now: NOW * 1000 });
    const m = market;
    const report = await runAssetScenario({ book: m.book, identities: m.identities, contractId: CONTRACT, now: () => NOW });

    expect(report.pairs).toHaveLength(3);
    for (const pair of report.pairs) {
      expect(pair.steps[0]).toBe("listed");
      expect(pair.steps).toContain("accepted");
      // BE-047: a match with an off-chain asset (class B or C) stays `proposed` until the receiver confirms the delivery or the window ends in silence
      const offChain = [pair.soldClass, pair.paidClass].some((c) => c === "B" || c === "C");
      expect(pair.bundle).toMatchObject({ status: offChain ? "proposed" : "ready", participants: 2 });
    }
    expect(report.classes).toEqual(["A", "B", "C", "D"]);
    expect((await m.book.listings({ status: "matched" })).map((l) => `${l.offer.assetType}/${l.offer.assetClass}`).sort()).toEqual([
      "access:repo-write-key/B", "compute:gpu-h100-hours/D", "nft:render-license/A",
    ]);

    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]).toMatchObject({ assetClass: "X", code: "asset_class_rejected", allowed: ["A", "B", "C", "D"] });
    expect(report.rejected[0]!.message).toContain("class X");
    expect((await m.book.listings({ status: "all" })).some((l) => l.offer.assetClass === "X")).toBe(false);
  });

  it("TC-AG-019-02 a pair with mismatched values does not become a bundle", async () => {
    market = await startMarketBook(AGENT_NAMES, { now: NOW * 1000 });
    const m = market;
    // pembeli hanya mau membayar 40% dari nilai listing: di bawah batas bawah penjual
    const stingy = [{ ...ASSET_PAIRS[0]!, buyerMaxUnitValue: "4000000" }];
    const report = await runAssetScenario({ book: m.book, identities: m.identities, contractId: CONTRACT, now: () => NOW, pairs: stingy });
    expect(report.pairs[0]!.steps).toContain("rejected");
    expect(report.pairs[0]!.bundle).toBeNull();
    expect((await m.book.listings({ status: "matched" }))).toHaveLength(0);
  });
});
