// Base scenario (AG-009): a dense closed circle of six agents. Each agent buys from the next two agents in the
// ring, so there is a cycle through all six agents. The payment plan is deterministic for the same seed.
import { AGENT_NAMES, type AgentName } from "../shared/registry.ts";

export type Payment = { buyer: AgentName; seller: AgentName };

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Buy edges: each agent to the next two agents in the ring (12 edges, including the six-edge ring). */
export function denseEdges(): Payment[] {
  return AGENT_NAMES.flatMap((buyer, i) =>
    [1, 2].map((step) => ({ buyer, seller: AGENT_NAMES[(i + step) % AGENT_NAMES.length]! })),
  );
}

/** `count` payments: every edge once first, the rest shuffled from the same edges by seed. */
export function planDensePayments(count: number, seed: number): Payment[] {
  const edges = denseEdges();
  if (count < edges.length) throw new Error(`count must be at least ${edges.length} so that every edge is used`);
  const random = prng(seed);
  const extra = Array.from({ length: count - edges.length }, () => edges[Math.floor(random() * edges.length)]!);
  return [...edges, ...extra];
}

/** There is a simple cycle through all nodes `nodes` on the directed edges `edges`. */
export function hasCycleThroughAll(nodes: readonly string[], edges: ReadonlyArray<{ debtor: string; creditor: string }>): boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.debtor, [...(next.get(e.debtor) ?? []), e.creditor]);
  const start = nodes[0]!;
  const visit = (node: string, seen: Set<string>): boolean => {
    if (seen.size === nodes.length) return (next.get(node) ?? []).includes(start);
    return (next.get(node) ?? []).some((n) => !seen.has(n) && nodes.includes(n) && visit(n, new Set([...seen, n])));
  };
  return visit(start, new Set([start]));
}
