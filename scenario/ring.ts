// Circular barter scenario A, B, C (AG-013, F5): each agent places an offer/need intent, the solver finds the ring A -> B -> C -> A, all three
// sign `terms_hash`, the bundle is committed, then each leg is paid with an F2 voucher that carries `bundle_id` (reserved headroom)
// until the leg is full. In F3 clearing the three legs cancel fully and each member's residual is zero. This module holds the ring definition and
// the leg payments; the orchestration with the solver and contract is in tests/barter.sandbox.test.ts (UM-055).
import { AGENTS, type AgentName } from "../shared/registry.ts";

/** Default price of one call (0.02 credit, FX-04). */
export const CALL_PRICE = 20_000;
/** Calls per leg: 5 × 0.02 = 0.1 credit. */
export const CALLS_PER_LEG = 5;
export const LEG_AMOUNT = CALL_PRICE * CALLS_PER_LEG;

/** Ring: each member provides one service and needs the next member's service; all have equal value (balanced). */
export const RING_MEMBERS = ["translator", "summarizer", "scraper"] as const satisfies readonly AgentName[];

export type RingSide = { service: string; calls: number; value: string };
export type RingIntent = { agent: AgentName; offer: RingSide; need: RingSide };

const side = (agent: AgentName): RingSide => ({ service: AGENTS[agent].verb, calls: CALLS_PER_LEG, value: String(LEG_AMOUNT) });

/** translator offers `translate` and needs `summarize`, and so on following the ring order. */
export function ringIntents(): RingIntent[] {
  return RING_MEMBERS.map((agent, i) => ({
    agent,
    offer: side(agent),
    need: side(RING_MEMBERS[(i + 1) % RING_MEMBERS.length]!),
  }));
}

export type LegPlan = { buyer: AgentName; seller: AgentName; calls: number };

/** Leg payment: the buyer pays the provider of the service it needs, `CALLS_PER_LEG` calls. */
export function legPayments(): LegPlan[] {
  return RING_MEMBERS.map((buyer, i) => ({ buyer, seller: RING_MEMBERS[(i + 1) % RING_MEMBERS.length]!, calls: CALLS_PER_LEG }));
}

export type PayFn = (buyer: AgentName, seller: AgentName) => Promise<Response>;

/** Run all leg payments through `pay`; throws if any is not HTTP 200. Returns the cumulative amount per pair. */
export async function payLegs(pay: PayFn): Promise<Record<string, bigint>> {
  const cumulative: Record<string, bigint> = {};
  for (const { buyer, seller, calls } of legPayments()) {
    for (let i = 0; i < calls; i += 1) {
      const response = await pay(buyer, seller);
      if (response.status !== 200) throw new Error(`${buyer} -> ${seller}: HTTP ${response.status} ${await response.text()}`);
      const key = `${buyer}>${seller}`;
      cumulative[key] = (cumulative[key] ?? 0n) + BigInt(CALL_PRICE);
    }
  }
  return cumulative;
}
