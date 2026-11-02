// Pencari otonom sisi agent (AG-018, F9): mendatangi agent idle yang opt-in dan menyiapkan penawaran ke listing berdiskon.
// Jalur bayar bila listing menerima pembayaran dan agent bisa membayar, selain itu barter bila agent punya barang yang dicari listing.
// Pagar spam sama dengan solver (SV-016): tanpa opt-in tidak ada penawaran, paling banyak `maxOffersPerAgent` per periode, dan
// pasangan (agent, listing) yang pernah ditolak tidak ditawari lagi. Rencana tidak mengirim apa pun; pengirim memanggil `record`.
import type { ListingView } from "./barter.ts";

/** Agent yang boleh dikunjungi pencari. */
export type VisitedAgent = {
  account: string;
  /** Agent setuju menerima ajakan pencari. */
  optIn: boolean;
  /** Tidak ada negosiasi atau bundle yang sedang berjalan. */
  idle: boolean;
  canPay: boolean;
  /** Barang yang bisa diserahkan. */
  offers: Array<{ assetType: string; assetClass: string; quantity: number }>;
};

export type SeekerPlan = {
  to: string;
  listing: ListingView;
  mode: "pay" | "barter";
  /** Nilai listing; hitungan diskon dan jatah mengikuti `planOffer`. */
  value: string;
  quantity: number;
};

export type SeekerBotConfig = {
  /** Akun yang menerima jatah pencari. */
  seeker: string;
  /** Jatah pencari, bps dari nilai listing; tidak boleh melebihi diskon listing. */
  searcherShareBps: number;
  maxOffersPerAgent: number;
  periodSeconds: number;
};

export class SeekerBot {
  readonly config: SeekerBotConfig;
  readonly #sent = new Map<string, number[]>();
  readonly #refused = new Set<string>();

  constructor(config: SeekerBotConfig) {
    this.config = config;
  }

  record(agent: string, now: number): void {
    this.#sent.set(agent, [...(this.#sent.get(agent) ?? []), now]);
  }

  refuse(agent: string, listingHash: string): void {
    this.#refused.add(`${agent}\u0000${listingHash}`);
  }

  #used(agent: string, now: number): number {
    return (this.#sent.get(agent) ?? []).filter((t) => t > now - this.config.periodSeconds).length;
  }

  /** Rencana deterministik: agent urut akun, listing urut hash; tidak mengirim apa pun. `now` dalam detik unix. */
  plan(listings: readonly ListingView[], agents: readonly VisitedAgent[], now: number): SeekerPlan[] {
    const book = listings
      .filter((l) => l.discountBps > 0 && l.discoverable && l.status === "open" && Date.parse(l.expiresAt) / 1000 > now)
      .filter((l) => this.config.searcherShareBps <= l.discountBps)
      .sort((a, b) => (a.listingHash < b.listingHash ? -1 : 1));
    const planned = new Map<string, number>();
    const out: SeekerPlan[] = [];
    for (const agent of [...agents].sort((a, b) => (a.account < b.account ? -1 : 1))) {
      if (!agent.optIn || !agent.idle) continue;
      for (const listing of book) {
        if (listing.account === agent.account || this.#refused.has(`${agent.account}\u0000${listing.listingHash}`)) continue;
        if (this.#used(agent.account, now) + (planned.get(agent.account) ?? 0) >= this.config.maxOffersPerAgent) break;
        const mode = listing.acceptPayment && agent.canPay ? "pay" : "barter";
        if (mode === "barter" && !agent.offers.some((o) => o.assetType === listing.want.assetType && o.assetClass === listing.want.assetClass && o.quantity >= listing.want.quantity)) continue;
        out.push({ to: agent.account, listing, mode, value: listing.offer.value, quantity: listing.offer.quantity });
        planned.set(agent.account, (planned.get(agent.account) ?? 0) + 1);
      }
    }
    return out;
  }
}
