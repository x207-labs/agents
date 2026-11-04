// Graph density variations (AG-010): low (ring), medium (ring + two-step jump), high (complete graph), and
// a star graph with no cycle. Payments are deterministic by seed; the summary is computed from the snapshot and the clearing proposal.
import { AGENT_NAMES, type AgentName } from "../shared/registry.ts";
import { prng, type Payment } from "./dense.ts";

export type Density = "low" | "medium" | "high" | "star";
export const DENSITIES: readonly Density[] = ["low", "medium", "high", "star"];

/** Buy edges for one level. Star: five agents buy from `gpu`, with no edge back. */
export function edgesFor(level: Density): Payment[] {
  const names = AGENT_NAMES;
  switch (level) {
    case "low":
      return names.map((buyer, i) => ({ buyer, seller: names[(i + 1) % names.length]! }));
    case "medium":
      return names.flatMap((buyer, i) => [1, 2].map((step) => ({ buyer, seller: names[(i + step) % names.length]! })));
    case "high":
      return names.flatMap((buyer) => names.filter((seller) => seller !== buyer).map((seller) => ({ buyer, seller })));
    case "star":
      return names.filter((n) => n !== "gpu").map((buyer) => ({ buyer, seller: "gpu" as AgentName }));
  }
}

/** `count` payments: each edge once, the rest random from that level's edges by seed. */
export function planDensity(level: Density, count: number, seed: number): Payment[] {
  const edges = edgesFor(level);
  if (count < edges.length) throw new Error(`count must be at least ${edges.length} for level ${level}`);
  const random = prng(seed);
  return [...edges, ...Array.from({ length: count - edges.length }, () => edges[Math.floor(random() * edges.length)]!)];
}

export type SnapshotEdge = { debtor: string; creditor: string; amount: string };
export type Summary = { clearedRatio: number | null; density: number | null; participants: number; edges: number };

const ratio4 = (a: bigint, b: bigint): number | null => (b === 0n ? null : Number((a * 20_000n + b) / (2n * b)) / 10_000);

/** Summary same as the backend metric: cleared ÷ total obligations and graph density. */
export function summarize(edges: readonly SnapshotEdge[], clearedTotal: bigint): Summary {
  const nodes = new Set(edges.flatMap((e) => [e.debtor, e.creditor]));
  const total = edges.reduce((sum, e) => sum + BigInt(e.amount), 0n);
  const n = nodes.size;
  return {
    clearedRatio: ratio4(clearedTotal, total),
    density: n < 2 ? null : Math.round((edges.length / (n * (n - 1))) * 10_000) / 10_000,
    participants: n,
    edges: edges.length,
  };
}
