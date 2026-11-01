import { describe, expect, it } from "vitest";
import { hasCycleThroughAll } from "../scenario/dense.ts";
import { AGENT_NAMES } from "../shared/registry.ts";
import { DENSITIES, edgesFor, planDensity, summarize } from "../scenario/density.ts";

describe("AG-010 variasi kepadatan", () => {
  it("jumlah edge naik: 6, 12, 30, bintang 5", () => {
    expect(DENSITIES.map((d) => edgesFor(d).length)).toEqual([6, 12, 30, 5]);
  });

  it("graf bintang tanpa siklus, tiga tingkat lain memuat siklus melewati keenam agent", () => {
    const as = (d: (typeof DENSITIES)[number]) => edgesFor(d).map((e) => ({ debtor: e.buyer, creditor: e.seller }));
    for (const level of ["low", "medium", "high"] as const) expect(hasCycleThroughAll(AGENT_NAMES, as(level)), level).toBe(true);
    expect(hasCycleThroughAll(AGENT_NAMES, as("star"))).toBe(false);
  });

  it("rencana deterministik menurut seed", () => {
    expect(planDensity("high", 60, 3)).toEqual(planDensity("high", 60, 3));
    expect(planDensity("high", 60, 3)).toHaveLength(60);
  });

  it("summarize: rasio 4 desimal dan kepadatan", () => {
    const edges = [
      { debtor: "a", creditor: "b", amount: "10" },
      { debtor: "b", creditor: "c", amount: "8" },
      { debtor: "c", creditor: "a", amount: "6" },
    ];
    expect(summarize(edges, 18n)).toEqual({ clearedRatio: 0.75, density: 0.5, participants: 3, edges: 3 });
    expect(summarize([], 0n).clearedRatio).toBeNull();
  });
});
