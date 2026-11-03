import { describe, expect, it } from "vitest";
import { AGENT_NAMES } from "../shared/registry.ts";
import { denseEdges, hasCycleThroughAll, planDensePayments } from "../scenario/dense.ts";

describe("AG-009 dense scenario plan", () => {
  it("TC-AG-009-05 the same seed gives an identical order, another seed differs", () => {
    const a = planDensePayments(300, 7);
    expect(planDensePayments(300, 7)).toEqual(a);
    expect(planDensePayments(300, 8)).not.toEqual(a);
    expect(a).toHaveLength(300);
  });

  it("TC-AG-009-02 all six agents appear as buyer and seller", () => {
    const plan = planDensePayments(300, 1);
    expect(new Set(plan.map((p) => p.buyer))).toEqual(new Set(AGENT_NAMES));
    expect(new Set(plan.map((p) => p.seller))).toEqual(new Set(AGENT_NAMES));
  });

  it("TC-AG-009-03 (plan) scenario edges hold a cycle through all six agents", () => {
    const edges = denseEdges().map((e) => ({ debtor: e.buyer, creditor: e.seller }));
    expect(hasCycleThroughAll(AGENT_NAMES, edges)).toBe(true);
    expect(hasCycleThroughAll(AGENT_NAMES, edges.filter((e) => e.creditor !== "gpu"))).toBe(false);
  });

  it("rejects a count below the edge count", () => {
    expect(() => planDensePayments(5, 1)).toThrow(/at least/);
  });
});
