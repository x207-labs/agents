// Autonomous seeker on the agent side (AG-018, F9): visits idle agents that opted in and prepares offers to discounted listings.
// Pay path if the listing accepts payment and the agent can pay, otherwise barter if the agent holds goods the listing seeks.
// Spam guard same as the solver (SV-016): no opt-in means no offer, at most `maxOffersPerAgent` per period, and
// a (agent, listing) pair that was rejected is not offered again. The plan sends nothing; the sender calls `record`.
import type { ListingView } from "./barter.ts";

/** An agent the seeker may visit. */
export type VisitedAgent = {
  account: string;
  /** The agent agrees to receive seeker referrals. */
  optIn: boolean;
  /** No negotiation or bundle is in progress. */
  idle: boolean;
  canPay: boolean;
  /** Goods that can be handed over. */
  offers: Array<{ assetType: string; assetClass: string; quantity: number }>;
};

export type SeekerPlan = {
  to: string;
  listing: ListingView;
  mode: "pay" | "barter";
  /** Listing value; the discount and share calculation follow `planOffer`. */
  value: string;
  quantity: number;
};

export type SeekerBotConfig = {
  /** Account that receives the seeker share. */
  seeker: string;
  /** Seeker share, bps of the listing value; must not exceed the listing discount. */
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

  /** Deterministic plan: agents ordered by account, listings ordered by hash; sends nothing. `now` in unix seconds. */
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
