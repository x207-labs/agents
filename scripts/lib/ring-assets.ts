// AG-055: the pure logic of the asset ring demo (scripts/demo-barter-ring-assets.ts): who sells what to whom, what the clearing of the cycle leaves,
// the cumulative amount of the next voucher of a pair, and whether the epoch still has room for `complete_escrow`. No chain access here, so it is unit tested.

/** `complete_escrow` is refused within this many nanoseconds of the cutoff (`ESCROW_CUTOFF_MARGIN_NS` of x207-circle/src/escrow.rs). */
export const ESCROW_CUTOFF_MARGIN_MS = 120_000;

export type RingMember = { name: string; account: string };
/** One leg of the ring: `seller` hands its asset to `buyer` through the escrow, `buyer` owes `seller` the price in credit units. */
export type RingLeg = { seller: string; buyer: string; price: bigint };

/** Member i sells its asset to member i+1, the last one to the first: A -> B -> C -> A. `prices` maps a seller name to the price of its asset. */
export function ringLegs(members: readonly RingMember[], prices: Readonly<Record<string, bigint>>): RingLeg[] {
  if (members.length < 3) throw new Error("a ring needs at least three members");
  if (new Set(members.map((m) => m.name)).size !== members.length) throw new Error("the members of a ring must be distinct");
  return members.map((m, i) => {
    const price = prices[m.name];
    if (price === undefined || price <= 0n) throw new Error(`the asset of ${m.name} has no positive price`);
    return { seller: m.name, buyer: members[(i + 1) % members.length]!.name, price };
  });
}

/** Prices that clear a loop and still leave a residue: all positive and not all equal (all equal would clear everything, nothing is left to settle). */
export function checkRingPrices(prices: readonly bigint[]): void {
  if (prices.length < 3) throw new Error("a ring needs at least three prices");
  if (prices.some((p) => p <= 0n)) throw new Error("every price must be positive");
  if (prices.every((p) => p === prices[0])) throw new Error("all prices are equal: the clearing would leave no residue to settle");
}

export type RingClearing = {
  /** What the clearing nets on every edge of the cycle: the smallest leg. */
  cleared: bigint;
  legs: { seller: string; buyer: string; gross: bigint; cleared: bigint; residue: bigint }[];
  totals: { gross: bigint; cleared: bigint; residue: bigint };
  /** Per member: owed minus owes after the clearing (positive is a net creditor, negative a net debtor). */
  net: Record<string, bigint>;
  /** USDT that moves: the sum of the net debts. */
  usdtDue: bigint;
};

/** The clearing of one simple cycle: every edge is reduced by the smallest leg (what `submit_clearing` proposes), the rest is the residue. */
export function clearRing(legs: readonly RingLeg[]): RingClearing {
  if (legs.length < 3) throw new Error("a ring needs at least three legs");
  const sellers = new Set(legs.map((l) => l.seller));
  const buyers = new Set(legs.map((l) => l.buyer));
  if (sellers.size !== legs.length || buyers.size !== legs.length || [...sellers].some((s) => !buyers.has(s))) throw new Error("the legs do not form one cycle");
  const cleared = legs.reduce((min, l) => (l.price < min ? l.price : min), legs[0]!.price);
  const rows = legs.map((l) => ({ seller: l.seller, buyer: l.buyer, gross: l.price, cleared, residue: l.price - cleared }));
  const net: Record<string, bigint> = Object.fromEntries([...sellers].map((s) => [s, 0n]));
  for (const r of rows) {
    net[r.seller]! += r.residue;
    net[r.buyer]! -= r.residue;
  }
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  return {
    cleared,
    legs: rows,
    totals: { gross: sum(rows.map((r) => r.gross)), cleared: sum(rows.map((r) => r.cleared)), residue: sum(rows.map((r) => r.residue)) },
    net,
    usdtDue: sum(Object.values(net).filter((n) => n < 0n).map((n) => -n)),
  };
}

/** The next voucher of a pair inside an epoch: one more seq, the cumulative amount raised by exactly the price (the escrow wants at least `unit_price`). */
export function nextVoucher(lastSeq: number, cumulativeBefore: bigint, price: bigint): { seq: number; cumulative: bigint } {
  if (!Number.isInteger(lastSeq) || lastSeq < 0) throw new Error(`bad last seq ${lastSeq}`);
  if (cumulativeBefore < 0n || price <= 0n) throw new Error("the cumulative amount cannot go down");
  return { seq: lastSeq + 1, cumulative: cumulativeBefore + price };
}

/** True when `complete_escrow` can still run `count` times before the cutoff: each call needs `perCallMs`, and none may start in the last margin. */
export function escrowWindowOpen(nowMs: number, cutoffMs: number, count: number, perCallMs = 20_000): boolean {
  return cutoffMs - nowMs > ESCROW_CUTOFF_MARGIN_MS + count * perCallMs;
}

/** A token id that is new for every run (the mock NFT refuses a token that exists), for example `ag055-1763078400-license`. */
export function ringTokenId(runTag: string, kind: string): string {
  const id = `ag055-${runTag}-${kind}`;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`bad token id ${id}`);
  return id;
}

/** The `EVENT_JSON` events of a list of logs (NEP-297), as `{ standard, event, data }`; other log lines are left out. */
export function eventsOf(logs: readonly string[]): { standard: string; event: string; data: unknown }[] {
  return logs.flatMap((line) => {
    if (!line.startsWith("EVENT_JSON:")) return [];
    try {
      const e = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: unknown };
      return typeof e.event === "string" ? [{ standard: String(e.standard ?? ""), event: e.event, data: e.data ?? null }] : [];
    } catch {
      return [];
    }
  });
}
