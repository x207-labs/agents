// AG-055: the pure logic of the asset ring demo (scripts/lib/ring-assets.ts).
import { describe, expect, it } from "vitest";
import { ESCROW_CUTOFF_MARGIN_MS, checkRingPrices, clearRing, escrowWindowOpen, eventsOf, nextVoucher, ringLegs, ringTokenId } from "../scripts/lib/ring-assets.ts";

const members = [
  { name: "alice", account: "alice.example.testnet" },
  { name: "bob", account: "bob.example.testnet" },
  { name: "carol", account: "carol.example.testnet" },
];
const credit = (n: number) => BigInt(n) * 1_000_000n;

describe("AG-055 ring of assets", () => {
  it("member i sells to member i+1 and the last one to the first", () => {
    const legs = ringLegs(members, { alice: credit(24), bob: credit(32), carol: credit(25) });
    expect(legs.map((l) => `${l.seller}>${l.buyer}:${l.price}`)).toEqual(["alice>bob:24000000", "bob>carol:32000000", "carol>alice:25000000"]);
  });

  it("refuses a ring that is too small, has a member twice or a price that is missing", () => {
    expect(() => ringLegs(members.slice(0, 2), { alice: 1n, bob: 1n })).toThrow(/three members/);
    expect(() => ringLegs([...members.slice(0, 2), members[0]!], { alice: 1n, bob: 1n })).toThrow(/distinct/);
    expect(() => ringLegs(members, { alice: 1n, bob: 1n })).toThrow(/carol has no positive price/);
    expect(() => ringLegs(members, { alice: 1n, bob: 0n, carol: 1n })).toThrow(/bob has no positive price/);
  });

  it("clears the smallest leg on every edge and leaves the residue (24/32/25)", () => {
    const c = clearRing(ringLegs(members, { alice: credit(24), bob: credit(32), carol: credit(25) }));
    expect(c.cleared).toBe(credit(24));
    expect(c.legs.map((l) => l.residue)).toEqual([0n, credit(8), credit(1)]);
    expect(c.totals).toEqual({ gross: credit(81), cleared: credit(72), residue: credit(9) });
    // bob sold for 32 and bought for 24: owed 8; carol owes 8 to bob and is owed 1 by alice; alice owes 1
    expect(c.net).toEqual({ alice: -credit(1), bob: credit(8), carol: -credit(7) });
    expect(c.usdtDue).toBe(credit(8));
    expect(Object.values(c.net).reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("refuses legs that are not one cycle", () => {
    expect(() => clearRing([{ seller: "a", buyer: "b", price: 1n }, { seller: "b", buyer: "a", price: 1n }, { seller: "c", buyer: "a", price: 1n }])).toThrow(/one cycle/);
  });

  it("wants prices that leave a residue", () => {
    expect(() => checkRingPrices([credit(5), credit(5), credit(5)])).toThrow(/no residue/);
    expect(() => checkRingPrices([credit(5), 0n, credit(6)])).toThrow(/positive/);
    expect(() => checkRingPrices([credit(5), credit(6)])).toThrow(/three prices/);
    expect(() => checkRingPrices([credit(24), credit(32), credit(25)])).not.toThrow();
  });

  it("raises the pair by exactly the price with the next seq", () => {
    expect(nextVoucher(0, 0n, credit(24))).toEqual({ seq: 1, cumulative: credit(24) });
    expect(nextVoucher(3, credit(10), credit(24))).toEqual({ seq: 4, cumulative: credit(34) });
    expect(() => nextVoucher(-1, 0n, 1n)).toThrow(/seq/);
    expect(() => nextVoucher(0, 0n, 0n)).toThrow(/cannot go down/);
  });

  it("keeps complete_escrow out of the last 120 s before the cutoff", () => {
    const cutoff = 1_000_000;
    expect(ESCROW_CUTOFF_MARGIN_MS).toBe(120_000);
    expect(escrowWindowOpen(cutoff - 300_000, cutoff, 3)).toBe(true);
    expect(escrowWindowOpen(cutoff - 180_000, cutoff, 3)).toBe(false);
    expect(escrowWindowOpen(cutoff - 121_000, cutoff, 0)).toBe(true);
    expect(escrowWindowOpen(cutoff - 120_000, cutoff, 0)).toBe(false);
  });

  it("makes a new token id per run and per kind", () => {
    expect(ringTokenId("1763078400", "license")).toBe("ag055-1763078400-license");
    expect(() => ringTokenId("Run 1", "license")).toThrow(/bad token id/);
  });

  it("reads the NEP-297 events of the logs and skips other lines", () => {
    const logs = ['EVENT_JSON:{"standard":"x207","version":"0.0.2","event":"escrow_held","data":[{"grant_id":7}]}', "plain log", "EVENT_JSON:{not json"];
    expect(eventsOf(logs)).toEqual([{ standard: "x207", event: "escrow_held", data: [{ grant_id: 7 }] }]);
  });
});
