// Skenario dasar (AG-009): lingkaran tertutup padat enam agent. Tiap agent membeli dari dua agent berikutnya di
// cincin, jadi ada siklus melewati keenam agent. Rencana pembayaran deterministik untuk seed yang sama.
import { AGENT_NAMES, type AgentName } from "../shared/registry.ts";

export type Payment = { buyer: AgentName; seller: AgentName };

/** PRNG kecil dan deterministik (mulberry32). */
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

/** Edge beli: tiap agent ke dua agent berikutnya di cincin (12 edge, termasuk cincin enam edge). */
export function denseEdges(): Payment[] {
  return AGENT_NAMES.flatMap((buyer, i) =>
    [1, 2].map((step) => ({ buyer, seller: AGENT_NAMES[(i + step) % AGENT_NAMES.length]! })),
  );
}

/** `count` pembayaran: setiap edge sekali lebih dulu, sisanya diacak dari edge yang sama menurut seed. */
export function planDensePayments(count: number, seed: number): Payment[] {
  const edges = denseEdges();
  if (count < edges.length) throw new Error(`count harus minimal ${edges.length} agar semua edge terpakai`);
  const random = prng(seed);
  const extra = Array.from({ length: count - edges.length }, () => edges[Math.floor(random() * edges.length)]!);
  return [...edges, ...extra];
}

/** Ada siklus sederhana melewati semua simpul `nodes` pada edge berarah `edges`. */
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
