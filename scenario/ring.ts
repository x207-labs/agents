// Skenario barter melingkar A, B, C (AG-013, F5): tiap agent memasang intent offer/need, solver menemukan cincin A -> B -> C -> A, ketiganya
// menandatangani `terms_hash`, bundle di-commit, lalu setiap leg dibayar dengan voucher F2 yang membawa `bundle_id` (headroom cadangan)
// sampai leg penuh. Di kliring F3 ketiga leg saling menghapus penuh dan residual tiap anggota nol. Modul ini memegang definisi cincin dan
// pembayaran leg; orkestrasi dengan solver dan kontrak ada di tests/barter.sandbox.test.ts (UM-055).
import { AGENTS, type AgentName } from "../shared/registry.ts";

/** Harga satu panggilan default (0,02 credit, FX-04). */
export const CALL_PRICE = 20_000;
/** Panggilan per leg: 5 × 0,02 = 0,1 credit. */
export const CALLS_PER_LEG = 5;
export const LEG_AMOUNT = CALL_PRICE * CALLS_PER_LEG;

/** Cincin: tiap anggota menyediakan satu jasa dan membutuhkan jasa anggota berikutnya; semua bernilai sama (seimbang). */
export const RING_MEMBERS = ["translator", "summarizer", "scraper"] as const satisfies readonly AgentName[];

export type RingSide = { service: string; calls: number; value: string };
export type RingIntent = { agent: AgentName; offer: RingSide; need: RingSide };

const side = (agent: AgentName): RingSide => ({ service: AGENTS[agent].verb, calls: CALLS_PER_LEG, value: String(LEG_AMOUNT) });

/** translator menawarkan `translate` dan butuh `summarize`, dst. mengikuti urutan cincin. */
export function ringIntents(): RingIntent[] {
  return RING_MEMBERS.map((agent, i) => ({
    agent,
    offer: side(agent),
    need: side(RING_MEMBERS[(i + 1) % RING_MEMBERS.length]!),
  }));
}

export type LegPlan = { buyer: AgentName; seller: AgentName; calls: number };

/** Pembayaran leg: pembeli membayar penyedia jasa yang ia butuhkan, `CALLS_PER_LEG` panggilan. */
export function legPayments(): LegPlan[] {
  return RING_MEMBERS.map((buyer, i) => ({ buyer, seller: RING_MEMBERS[(i + 1) % RING_MEMBERS.length]!, calls: CALLS_PER_LEG }));
}

export type PayFn = (buyer: AgentName, seller: AgentName) => Promise<Response>;

/** Jalankan semua pembayaran leg lewat `pay`; melempar bila ada yang bukan HTTP 200. Mengembalikan jumlah kumulatif per pasangan. */
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
