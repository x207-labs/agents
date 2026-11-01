import { describe, expect, it } from "vitest";
import { AGENT_NAMES } from "../shared/registry.ts";
import { denseEdges, hasCycleThroughAll, planDensePayments } from "../scenario/dense.ts";

describe("AG-009 rencana skenario padat", () => {
  it("TC-AG-009-05 seed sama menghasilkan urutan identik, seed lain berbeda", () => {
    const a = planDensePayments(300, 7);
    expect(planDensePayments(300, 7)).toEqual(a);
    expect(planDensePayments(300, 8)).not.toEqual(a);
    expect(a).toHaveLength(300);
  });

  it("TC-AG-009-02 keenam agent muncul sebagai pembeli dan penjual", () => {
    const plan = planDensePayments(300, 1);
    expect(new Set(plan.map((p) => p.buyer))).toEqual(new Set(AGENT_NAMES));
    expect(new Set(plan.map((p) => p.seller))).toEqual(new Set(AGENT_NAMES));
  });

  it("TC-AG-009-03 (rencana) edge skenario memuat siklus melewati keenam agent", () => {
    const edges = denseEdges().map((e) => ({ debtor: e.buyer, creditor: e.seller }));
    expect(hasCycleThroughAll(AGENT_NAMES, edges)).toBe(true);
    expect(hasCycleThroughAll(AGENT_NAMES, edges.filter((e) => e.creditor !== "gpu"))).toBe(false);
  });

  it("menolak count di bawah jumlah edge", () => {
    expect(() => planDensePayments(5, 1)).toThrow(/minimal/);
  });
});
