// Agent marketplace policy (AG-016, F9): create listings from the owner's goods and needs, judge offers, counter, accept or reject.
// The base decision is a deterministic rule from the owner's policy ("mock mode"). With a `live` LLM client, the model may propose
// a decision, but a proposal that violates the policy limits (value below the floor or above the ceiling, unknown action word) is dropped
// and the base rule is used: the owner's policy always wins over model output.
import {
  ASSET_CLASSES, listingHash, planOffer, signBundle, signListing, signOffer, signReferral, signRefuseReferral, termsHash,
  type AssetClass, type Listing, type Offer, type Referral,
} from "@x207/core";
import { BookClient, BundleLimit, type BundleLimitOptions, type AcceptResult, type ListingView, type OfferView, type ReferralView } from "./barter.ts";
import type { SeekerPlan } from "./seeker.ts";
import type { AgentIdentity } from "./identity.ts";
import type { LlmClient } from "./nearai.ts";
import { AppraiserError, askingTotal, creditsOf, detailWithAppraisal, type AppraisalAsset, type AppraiserClient, type Appraisal } from "./appraiser.ts";

/** Goods the owner holds and may release. `unitValue` is in credit smallest units per unit. */
export type Holding = { assetType: string; assetClass: AssetClass; quantity: number; unitValue: string };
/** The owner's need; `maxUnitValue` is the price limit per unit they are willing to pay. */
export type Need = { assetType: string; assetClass: AssetClass; quantity: number; maxUnitValue: string };

export type BarterPolicy = {
  holdings: Holding[];
  needs: Need[];
  /** Quick barter discount on the listing, bps of the `offer` value. */
  discountBps: number;
  acceptPayment: boolean;
  discoverable: boolean;
  listingTtlSeconds: number;
  /** Seller: accept an offer worth at least this share of the listing `offer` value (bps). */
  minAcceptBps: number;
  /** Seller: reject outright an offer below this share (bps), with no counter. */
  rejectBelowBps: number;
  /** Bidder: opening bid as a share of the listing `offer` value (bps). */
  openingBps: number;
  /** Size of the concession per round (bps of the listing `offer` value). */
  stepBps: number;
  maxRounds: number;
  /** Seeker referral opt-in (SV-016): without it every referral in the inbox is rejected. */
  acceptReferrals: boolean;
  /** Seller: the quantity per order must not exceed the listing; always enforced. */
  deliverDays: number;
};

const AMOUNT_TEXT = /^[1-9]\d{0,37}$/;
const BPS_FIELDS = ["discountBps", "minAcceptBps", "rejectBelowBps", "openingBps", "stepBps"] as const;

/**
 * A-AG-16: the policy comes from a file or from the owner; one wrong number (a unit value of "1.5", a quantity of 0, bps of 12000) made `BigInt()` throw in the middle of a run.
 * Returns the policy over the defaults, or throws one error that names the field.
 */
export function parseBarterPolicy(input: unknown): BarterPolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("barter policy must be an object");
  const raw = input as Record<string, unknown>;
  const policy = { ...DEFAULT_BARTER_POLICY, ...raw } as BarterPolicy;
  for (const field of BPS_FIELDS) {
    const v = policy[field];
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new Error(`barter policy ${field} must be an integer from 0 to 10000`);
  }
  for (const [field, min] of [["maxRounds", 1], ["listingTtlSeconds", 1], ["deliverDays", 0]] as const) {
    const v = policy[field];
    if (!Number.isInteger(v) || v < min) throw new Error(`barter policy ${field} must be an integer of at least ${min}`);
  }
  if (policy.rejectBelowBps > policy.minAcceptBps) throw new Error("barter policy rejectBelowBps must not exceed minAcceptBps");
  for (const field of ["acceptPayment", "discoverable", "acceptReferrals"] as const) if (typeof policy[field] !== "boolean") throw new Error(`barter policy ${field} must be true or false`);
  for (const [list, price] of [["holdings", "unitValue"], ["needs", "maxUnitValue"]] as const) {
    const items = policy[list] as Array<Record<string, unknown>>;
    if (!Array.isArray(items)) throw new Error(`barter policy ${list} must be a list`);
    items.forEach((item, i) => {
      if (typeof item !== "object" || item === null || typeof item.assetType !== "string" || item.assetType === "") throw new Error(`barter policy ${list}[${i}].assetType must be a text`);
      if (!Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1) throw new Error(`barter policy ${list}[${i}].quantity must be a positive integer`);
      if (typeof item[price] !== "string" || !AMOUNT_TEXT.test(item[price] as string)) throw new Error(`barter policy ${list}[${i}].${price} must be a positive integer as text`);
    });
  }
  return policy;
}

export const DEFAULT_BARTER_POLICY: BarterPolicy = {
  holdings: [],
  needs: [],
  discountBps: 1000,
  acceptPayment: true,
  discoverable: true,
  listingTtlSeconds: 86_400,
  minAcceptBps: 9000,
  rejectBelowBps: 5000,
  openingBps: 8500,
  stepBps: 500,
  maxRounds: 6,
  acceptReferrals: true,
  deliverDays: 3,
};

const BPS = 10_000n;
const bps = (value: bigint | string, part: number | bigint): bigint => (BigInt(value) * BigInt(part)) / BPS;

export type Decision =
  | { action: "accept" }
  | { action: "counter"; value: string }
  | { action: "reject"; reason: string };

export type DecisionContext = {
  /** The agent's role in this thread. */
  role: "seller" | "buyer";
  listing: Pick<Listing, "offer" | "want" | "accept_payment" | "expires_at">;
  /** Incoming offer waiting for this agent's answer. */
  offer: Pick<Offer, "round" | "mode" | "value" | "quantity">;
  /** The agent's own latest offer value in this thread (bidder), if any. */
  ownLastValue?: string;
  policy: BarterPolicy;
  /** Detik unix. */
  now: number;
};

/**
 * The most the buyer may pay for the `offer` side of a listing: the need ceiling (`maxUnitValue` × the units it still needs, at most the listing quantity), never above the
 * listed value. Without a matching need: `minAcceptBps` of the listed value. A-AG-01/02: every path that makes a bid or accepts a counter uses this one number.
 */
export function buyerCeiling(policy: BarterPolicy, side: Pick<Listing["offer"], "asset_type" | "quantity" | "value">): bigint {
  const listed = BigInt(side.value);
  const need = policy.needs.find((n) => n.assetType === side.asset_type);
  const ceiling = need ? BigInt(need.maxUnitValue) * BigInt(Math.min(need.quantity, side.quantity)) : bps(listed, policy.minAcceptBps);
  return ceiling < listed ? ceiling : listed;
}

/** The most units the buyer may ask for on this listing: what it still needs, at most the listing quantity. 0 without a matching need. */
export function buyerQuantityCap(policy: BarterPolicy, side: Pick<Listing["offer"], "asset_type" | "quantity">): number {
  const need = policy.needs.find((n) => n.assetType === side.asset_type);
  return need ? Math.min(need.quantity, side.quantity) : 0;
}

/** Base rule. Seller: accept above the floor, reject below the lower bound, otherwise counter downward from the listing price each round. */
export function decideRule(ctx: DecisionContext): Decision {
  const { listing, offer, policy } = ctx;
  // A-AG-16: an amount that is not a plain integer made BigInt() throw and stopped the whole run; a zero value passed the floor of a 1-unit listing (bps rounds down to 0)
  if (!/^\d+$/.test(listing.offer.value) || !/^\d+$/.test(offer.value)) return { action: "reject", reason: "bad_amount" };
  const listed = BigInt(listing.offer.value);
  const value = BigInt(offer.value);
  if (value === 0n) return { action: "reject", reason: "value_not_positive" };
  if (listing.expires_at <= ctx.now) return { action: "reject", reason: "listing_expired" };
  if (offer.mode === "pay" && !listing.accept_payment) return { action: "reject", reason: "payment_not_accepted" };

  if (ctx.role === "seller") {
    if (offer.quantity > listing.offer.quantity) return { action: "reject", reason: "quantity_exceeds_listing" };
    const floor = bps(listed, policy.minAcceptBps);
    if (value >= floor) return { action: "accept" };
    if (value < bps(listed, policy.rejectBelowBps)) return { action: "reject", reason: "too_low" };
    if (offer.round >= policy.maxRounds) return { action: "reject", reason: "max_rounds" };
    // Concession starts at the listing price: round 2 steps down once, and so on, never below the floor.
    const asked = listed - bps(listed, policy.stepBps) * BigInt(Math.max(1, Math.floor(offer.round / 2)));
    const counter = asked > floor ? asked : floor;
    return counter <= value ? { action: "accept" } : { action: "counter", value: counter.toString() };
  }

  // The bidder judges the seller's counter-offer: accept if it does not exceed the need ceiling.
  // A-AG-06: the ceiling is for the units the buyer needs; a counter with fewer units at that price is not the deal it wants
  if (offer.quantity < buyerQuantityCap(policy, listing.offer)) return { action: "reject", reason: "quantity_below_need" };
  const cap = buyerCeiling(policy, listing.offer);
  if (value <= cap) return { action: "accept" };
  if (offer.round >= policy.maxRounds) return { action: "reject", reason: "max_rounds" };
  const last = ctx.ownLastValue ? BigInt(ctx.ownLastValue) : bps(listed, policy.openingBps);
  const next = last + bps(listed, policy.stepBps);
  const bid = next < cap ? next : cap;
  if (bid >= value) return { action: "accept" };
  return { action: "counter", value: bid.toString() };
}

function validAgainstPolicy(decision: Decision, ctx: DecisionContext): boolean {
  if (decision.action === "reject") return typeof decision.reason === "string";
  const listed = BigInt(ctx.listing.offer.value);
  if (decision.action === "accept") {
    // Accepting an offer below the seller floor or above the bidder ceiling violates the policy.
    return decideRule(ctx).action === "accept";
  }
  if (!/^[1-9]\d*$/.test(decision.value)) return false;
  const value = BigInt(decision.value);
  return ctx.role === "seller" ? value >= bps(listed, ctx.policy.minAcceptBps) && value <= listed : value > 0n && value <= buyerCeiling(ctx.policy, ctx.listing.offer);
}

/** The live LLM decision if valid under the policy; otherwise the base rule. */
export async function decide(ctx: DecisionContext, llm?: LlmClient): Promise<Decision & { source: "rule" | "llm" }> {
  const base = decideRule(ctx);
  if (!llm || llm.mode !== "live") return { ...base, source: "rule" };
  const system =
    'You decide for a barter agent. Reply with JSON only: {"action":"accept"}, {"action":"counter","value":"<integer>"} or {"action":"reject","reason":"<short>"}. ' +
    "Amounts are integers in credit micro-units. Follow the rule suggestion unless you have a reason to deviate within the round limit.";
  // A-AG-18: the owner's reservation prices (floors, ceilings, unit values) do not leave this process; the model gets the thread and the rule's answer, and `validAgainstPolicy` checks what it says
  const input = JSON.stringify({ role: ctx.role, listing: ctx.listing, offer: ctx.offer, ownLastValue: ctx.ownLastValue, maxRounds: ctx.policy.maxRounds, ruleSuggestion: base });
  try {
    const raw = await llm.complete(system, input);
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Decision;
    if (parsed && ["accept", "counter", "reject"].includes(parsed.action) && validAgainstPolicy(parsed, ctx)) {
      return { ...parsed, ...(parsed.action === "reject" ? { reason: parsed.reason.slice(0, 120) } : {}), source: "llm" };
    }
  } catch {
    // model output is unreadable: use the base rule
  }
  return { ...base, source: "rule" };
}

const NONCE = /[^A-Za-z0-9_-]/g;

/** Listing from one good and one need of the owner; value = unit price × quantity. */
export function buildListing(args: {
  identity: AgentIdentity;
  contractId: string;
  policy: BarterPolicy;
  now: number;
  nonce: string;
  holding?: number;
  need?: number;
  /** AG-051: asking total from an appraisal (smallest units) instead of unit price × quantity. */
  offerValue?: string;
  /** AG-051: the appraisal named in `detail` (`appraisal=apr_...`). */
  appraisalId?: string;
}): Listing {
  const holding = args.policy.holdings[args.holding ?? 0];
  const need = args.policy.needs[args.need ?? 0];
  if (!holding) throw new Error("the policy has no holding to list");
  if (!need) throw new Error("the policy has no need to look for");
  for (const item of [holding, need]) {
    if (!(ASSET_CLASSES as readonly string[]).includes(item.assetClass)) throw new Error(`asset class ${item.assetClass} cannot be listed`);
  }
  return {
    circle: args.contractId,
    account: args.identity.accountId,
    offer: { asset_type: holding.assetType, asset_class: holding.assetClass, quantity: holding.quantity, value: args.offerValue ?? String(BigInt(holding.unitValue) * BigInt(holding.quantity)) },
    want: { asset_type: need.assetType, asset_class: need.assetClass, quantity: need.quantity, value: String(BigInt(need.maxUnitValue) * BigInt(need.quantity)) },
    terms: "delivery as agreed in the accepted offer",
    detail: args.appraisalId ? detailWithAppraisal(`${holding.assetType} for ${need.assetType}`, args.appraisalId) : `${holding.assetType} for ${need.assetType}`,
    expires_at: args.now + args.policy.listingTtlSeconds,
    discount_bps: args.policy.discountBps,
    accept_payment: args.policy.acceptPayment,
    discoverable: args.policy.discoverable,
    nonce: args.nonce.replace(NONCE, "-").slice(0, 64),
  };
}

/** Listing from the book that matches the agent's need: the listing `offer` = the need and the listing `want` = the goods the agent holds. */
export function matchesPolicy(listing: Pick<ListingView, "offer" | "want" | "account">, self: string, policy: BarterPolicy): "barter" | "pay" | null {
  if (listing.account === self) return null;
  const need = policy.needs.find((n) => n.assetType === listing.offer.assetType && n.assetClass === listing.offer.assetClass);
  if (!need) return null;
  const gives = policy.holdings.some((h) => h.assetType === listing.want.assetType && h.assetClass === listing.want.assetClass);
  return gives ? "barter" : "pay";
}

export type StepResult =
  | { kind: "accepted"; listingHash: string; offerHash: string; result: AcceptResult }
  | { kind: "countered"; listingHash: string; offerHash: string; round: number; value: string }
  | { kind: "rejected"; listingHash: string; offerHash: string; reason: string }
  | { kind: "bid"; listingHash: string; offerHash: string; mode: "pay" | "barter"; value: string };

export type PolicyAgentOptions = {
  identity: AgentIdentity;
  book: BookClient;
  contractId: string;
  policy: BarterPolicy;
  llm?: LlmClient;
  /** Detik unix. */
  now?: () => number;
  /** Owner limits on the bundles this agent signs (AG-046): `maxBundlePerEpoch`, `maxBundleLeg`. Without them bundles are bounded only by the policy. */
  bundleLimit?: BundleLimitOptions;
  /**
   * AG-051: ask the x207 appraiser (NEAR AI Cloud, TEE) before pricing a listing. `describe` adds what the appraiser needs beyond the
   * holding (scope, provider, duration). The appraised value is used only when its signature was checked, and is kept within
   * `maxDeviationBps` (default 5000) of the owner's own total. When the appraiser fails, the owner's price is listed without it.
   */
  appraiser?: {
    client: AppraiserClient;
    describe: (holding: Holding) => Pick<AppraisalAsset, "scope" | "provider" | "duration_days" | "description">;
    maxDeviationBps?: number;
  };
};

/** An agent that runs its owner's marketplace policy against the listing book. */
export class PolicyAgent {
  readonly identity: AgentIdentity;
  readonly book: BookClient;
  readonly policy: BarterPolicy;
  readonly #contractId: string;
  readonly #llm: LlmClient | undefined;
  readonly #now: () => number;
  readonly #limit: BundleLimit;
  readonly #appraiser: PolicyAgentOptions["appraiser"];
  readonly #listings = new Map<string, Listing>();
  readonly #ownLast = new Map<string, string>();
  #counter = 0;

  constructor(options: PolicyAgentOptions) {
    this.identity = options.identity;
    this.book = options.book;
    this.policy = parseBarterPolicy(options.policy);
    this.#contractId = options.contractId;
    this.#llm = options.llm;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#limit = new BundleLimit(options.identity.accountId, options.bundleLimit);
    this.#appraiser = options.appraiser;
  }

  /** Place listings from the owner's goods and needs; with an appraiser, ask it first (AG-051). */
  async list(holding = 0, need = 0): Promise<{ listing: Listing; hash: string; appraisal?: Appraisal; appraisalError?: string }> {
    const nonce = `${this.identity.accountId.split(".")[0]}-${this.#now()}-${(this.#counter += 1)}`;
    const priced = await this.#appraise(holding);
    const listing = buildListing({
      identity: this.identity, contractId: this.#contractId, policy: this.policy, now: this.#now(), nonce, holding, need,
      ...(priced.appraisal ? { appraisalId: priced.appraisal.appraisal_id } : {}),
      ...(priced.offerValue ? { offerValue: priced.offerValue } : {}),
    });
    await this.book.postListing(listing, signListing(listing, this.identity.voucherSecretKey));
    const hash = listingHash(listing);
    this.#listings.set(hash, listing);
    return { listing, hash, ...(priced.appraisal ? { appraisal: priced.appraisal } : {}), ...(priced.error ? { appraisalError: priced.error } : {}) };
  }

  async #appraise(index: number): Promise<{ appraisal?: Appraisal; offerValue?: string; error?: string }> {
    const holding = this.policy.holdings[index];
    if (!this.#appraiser || !holding) return {};
    const ownerTotal = BigInt(holding.unitValue) * BigInt(holding.quantity);
    try {
      const appraisal = await this.#appraiser.client.appraise({
        asset_type: holding.assetType, asset_class: holding.assetClass, quantity: holding.quantity,
        market_price_credits: creditsOf(ownerTotal), ...this.#appraiser.describe(holding),
      });
      const asked = askingTotal(ownerTotal, appraisal, this.#appraiser.maxDeviationBps);
      return { appraisal, ...(asked.used ? { offerValue: asked.total.toString() } : {}) };
    } catch (err) {
      return { error: err instanceof AppraiserError ? err.code : err instanceof Error ? err.message : "appraiser failed" };
    }
  }

  #toListing(view: ListingView): Listing {
    return {
      circle: this.#contractId, account: view.account,
      offer: { asset_type: view.offer.assetType, asset_class: view.offer.assetClass as AssetClass, quantity: view.offer.quantity, value: view.offer.value },
      want: { asset_type: view.want.assetType, asset_class: view.want.assetClass as AssetClass, quantity: view.want.quantity, value: view.want.value },
      terms: view.terms, detail: view.detail, expires_at: Math.floor(Date.parse(view.expiresAt) / 1000),
      discount_bps: view.discountBps, accept_payment: view.acceptPayment, discoverable: view.discoverable, nonce: view.nonce,
    };
  }

  async #postOffer(listing: ListingView, round: number, mode: "pay" | "barter", value: string, quantity: number, inReplyTo?: string, referralHashHex?: string): Promise<OfferView> {
    const offer: Offer = {
      circle: this.#contractId, listing_hash: listing.listingHash, proposer: this.identity.accountId, round, mode, value, quantity,
      deliver_by: this.#now() + this.policy.deliverDays * 86_400,
    };
    const view = await this.book.postOffer(listing.listingHash, offer, signOffer(offer, this.identity.voucherSecretKey), inReplyTo, referralHashHex);
    this.#ownLast.set(listing.listingHash, value);
    return view;
  }

  /**
   * Seeker: sign the referral from the `SeekerBot` plan and send it to the target agent's inbox. The offer itself must still be signed
   * by the target agent itself (`handleReferrals`). `ttlSeconds` defaults to 1 hour.
   */
  async sendReferral(plan: SeekerPlan, searcherShareBps: number, ttlSeconds = 3600): Promise<ReferralView> {
    const referral: Referral = {
      circle: this.#contractId, seeker: this.identity.accountId, to: plan.to, listing_hash: plan.listing.listingHash, mode: plan.mode, value: plan.value,
      quantity: plan.quantity, deliver_by: this.#now() + this.policy.deliverDays * 86_400, searcher_share_bps: searcherShareBps,
      expires_at: this.#now() + ttlSeconds, nonce: `${this.identity.accountId.split(".")[0]}-${this.#now()}-${(this.#counter += 1)}`.replace(NONCE, "-").slice(0, 64),
    };
    const view = await this.book.postReferral(referral, signReferral(referral, this.identity.voucherSecretKey));
    return view;
  }

  /**
   * Target agent: answer referrals in the inbox. A referral that matches the agent's need and the `acceptReferrals` policy is answered with
   * a round 1 offer made by the agent itself that cites the referral (the seeker's share is attached to the thread); otherwise it is rejected with a signature.
   */
  async handleReferrals(): Promise<Array<{ referralHash: string; action: "bid" | "refused"; reason?: string; offerHash?: string }>> {
    const answers: Array<{ referralHash: string; action: "bid" | "refused"; reason?: string; offerHash?: string }> = [];
    const open = await this.book.listings({ status: "open" });
    for (const referral of await this.book.referralInbox(this.identity.accountId)) {
      const view = open.find((l) => l.listingHash === referral.listingHash);
      const fit = view ? matchesPolicy(view, this.identity.accountId, this.policy) : null;
      const side = view ? { asset_type: view.offer.assetType, quantity: view.offer.quantity, value: view.offer.value } : undefined;
      // A-AG-01: the seeker's value and quantity are not trusted: above the owner's ceiling, or more units than the owner needs, the referral is refused
      const reason = !this.policy.acceptReferrals ? "not_opted_in" : !view ? "listing_gone" : fit === null ? "no_need" : referral.mode === "barter" && fit !== "barter" ? "no_goods"
        : !/^[1-9]\d*$/.test(referral.value) || BigInt(referral.value) > buyerCeiling(this.policy, side!) ? "over_ceiling"
        : !Number.isInteger(referral.quantity) || referral.quantity < 1 || referral.quantity > buyerQuantityCap(this.policy, side!) ? "quantity_over_need" : undefined;
      if (reason !== undefined) {
        await this.book.refuseReferral(referral.referralHash, signRefuseReferral(referral.referralHash, this.#contractId, this.identity.voucherSecretKey));
        answers.push({ referralHash: referral.referralHash, action: "refused", reason });
        continue;
      }
      const sent = await this.#postOffer(view!, 1, referral.mode, referral.value, referral.quantity, undefined, referral.referralHash);
      answers.push({ referralHash: referral.referralHash, action: "bid", offerHash: sent.offerHash });
    }
    return answers;
  }

  /** Find listings that match the need and make an opening offer (round 1). */
  async shop(): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (const view of await this.book.listings({ status: "open" })) {
      const mode = matchesPolicy(view, this.identity.accountId, this.policy);
      if (!mode || (mode === "pay" && !view.acceptPayment)) continue;
      const mine = (await this.book.offersOf(view.listingHash)).some((o) => o.counterparty === this.identity.accountId);
      if (mine) continue;
      const need = this.policy.needs.find((n) => n.assetType === view.offer.assetType)!;
      const cap = BigInt(need.maxUnitValue) * BigInt(Math.min(need.quantity, view.offer.quantity));
      const opening = bps(view.offer.value, this.policy.openingBps);
      const value = (opening < cap ? opening : cap).toString();
      const offer = await this.#postOffer(view, 1, mode, value, Math.min(need.quantity, view.offer.quantity));
      results.push({ kind: "bid", listingHash: view.listingHash, offerHash: offer.offerHash, mode, value });
    }
    return results;
  }

  /**
   * Send a round 1 offer from a seeker referral (SV-015): value = listing value, method and quantity from the seeker plan. Only agents
   * that opted in call this; the offer is signed by the agent itself.
   */
  async bidFromReferral(plan: { listing: ListingView; mode: "pay" | "barter"; value: string; quantity: number }): Promise<StepResult> {
    // A-AG-01: the plan comes from a seeker; the same ceilings as `shop()` and `handleReferrals()` apply
    const side = { asset_type: plan.listing.offer.assetType, quantity: plan.listing.offer.quantity, value: plan.listing.offer.value };
    if (!/^[1-9]\d*$/.test(plan.value) || BigInt(plan.value) > buyerCeiling(this.policy, side)) throw new Error("bid_over_ceiling: the value is above the need ceiling of the owner");
    if (!Number.isInteger(plan.quantity) || plan.quantity < 1 || plan.quantity > buyerQuantityCap(this.policy, side)) throw new Error("bid_quantity_over_need: more units than the owner needs");
    const offer = await this.#postOffer(plan.listing, 1, plan.mode, plan.value, plan.quantity);
    return { kind: "bid", listingHash: plan.listing.listingHash, offerHash: offer.offerHash, mode: plan.mode, value: plan.value };
  }

  /**
   * Answer an offer in the inbox according to the policy: accept, counter, or reject. `referral` names the seeker that brought
   * the offer (if any); their share becomes a leg in the same bundle.
   */
  async handleInbox(options: { referral?: (offer: OfferView) => { searcher: string; searcherShareBps: number } | undefined } = {}): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (const incoming of await this.book.inbox(this.identity.accountId)) {
      const [view] = (await this.book.listings({ status: "all" })).filter((l) => l.listingHash === incoming.listingHash);
      if (!view) continue;
      const listing = this.#toListing(view);
      const role = view.account === this.identity.accountId ? "seller" : "buyer";
      const ctx: DecisionContext = {
        role, listing, offer: { round: incoming.round, mode: incoming.mode, value: incoming.value, quantity: incoming.quantity },
        ...(this.#ownLast.get(view.listingHash) ? { ownLastValue: this.#ownLast.get(view.listingHash)! } : {}), policy: this.policy, now: this.#now(),
      };
      const decision = await decide(ctx, this.#llm);
      if (decision.action === "reject") {
        results.push({ kind: "rejected", listingHash: view.listingHash, offerHash: incoming.offerHash, reason: decision.reason });
      } else if (decision.action === "counter") {
        const sent = await this.#postOffer(view, incoming.round + 1, incoming.mode, decision.value, incoming.quantity, incoming.offerHash);
        results.push({ kind: "countered", listingHash: view.listingHash, offerHash: sent.offerHash, round: sent.round, value: decision.value });
      } else {
        results.push({
          kind: "accepted", listingHash: view.listingHash, offerHash: incoming.offerHash,
          result: await this.#accept(view.listingHash, incoming.offerHash, options.referral?.(incoming)),
        });
      }
    }
    return results;
  }

  /**
   * Sign a bundle proposal from this agent's negotiation only if its terms equal the local `planOffer` computation over the listing and
   * the accepted offer (the seeker share is read from the seeker leg). Other proposals are rejected.
   */
  async signProposals(): Promise<Array<{ termsHash: string; action: "signed" | "rejected"; reason?: string }>> {
    const account = this.identity.accountId;
    const answers: Array<{ termsHash: string; action: "signed" | "rejected"; reason?: string }> = [];
    const views = await this.book.listings({ status: "all" });
    for (const proposal of await this.book.proposals(account, "proposed")) {
      if (!proposal.missing.includes(account)) continue;
      const view = views.find((l) => l.listingHash === proposal.listingHash);
      const accepted = view ? (await this.book.offersOf(view.listingHash)).find((o) => o.status === "accepted") : undefined;
      if (!view || !accepted) {
        answers.push({ termsHash: proposal.termsHash, action: "rejected", reason: "unknown_negotiation" });
        continue;
      }
      const listing = this.#toListing(view);
      const offer: Offer = {
        circle: this.#contractId, listing_hash: view.listingHash, proposer: accepted.proposer, round: accepted.round, mode: accepted.mode,
        value: accepted.value, quantity: accepted.quantity, deliver_by: Math.floor(Date.parse(accepted.deliverBy) / 1000),
      };
      const searcher = proposal.participants.find((p) => p !== view.account && p !== accepted.counterparty);
      const leg = searcher ? proposal.terms.legs.find((l) => l.payee === searcher) : undefined;
      // The seeker share is computed from the deal value (Offer.value of the accepted offer).
      const listed = BigInt(accepted.value);
      const base = leg ? Number((BigInt(leg.max_amount) * BPS) / listed) : 0;
      // Rounding down when the server computes the share: try the nearest bps that yields the same leg amount.
      const candidates = leg ? [base, base + 1] : [0];
      const served = termsHash(proposal.terms) === proposal.termsHash;
      const match = served && candidates.some((share) => {
        try {
          const plan = planOffer({ listing, offer, epoch: proposal.epoch, counterparty: accepted.counterparty, ...(searcher ? { searcher, searcherShareBps: share } : {}) });
          return plan.kind === "bundle" && plan.terms_hash === proposal.termsHash;
        } catch {
          return false;
        }
      });
      if (!match) {
        answers.push({ termsHash: proposal.termsHash, action: "rejected", reason: "terms_differ_from_negotiation" });
        continue;
      }
      // reserve before the first await: a signing that runs at the same time must see this one in the count
      const over = this.#limit.reserve(proposal.terms);
      if (over) {
        answers.push({ termsHash: proposal.termsHash, action: "rejected", reason: over });
        continue;
      }
      try {
        await this.book.signProposal(proposal.termsHash, account, signBundle(proposal.terms, account, this.identity.voucherSecretKey).signature);
      } catch (error) {
        this.#limit.release(proposal.terms);
        throw error;
      }
      answers.push({ termsHash: proposal.termsHash, action: "signed" });
    }
    return answers;
  }

  async #accept(listingHashHex: string, offerHashHex: string, referral?: { searcher: string; searcherShareBps: number }): Promise<AcceptResult> {
    const account = this.identity.accountId;
    const seeker = referral ? { searcher: referral.searcher, searcherShareBps: referral.searcherShareBps } : {};
    const preview = await this.book.previewAccept(listingHashHex, offerHashHex, { account, ...seeker });
    if (!preview.bundle) return this.book.accept(listingHashHex, offerHashHex, { account, epoch: preview.epoch, ...seeker });
    if (termsHash(preview.bundle.terms) !== preview.bundle.termsHash) throw new Error("terms_hash from the server does not match the bundle terms");
    // A-AG-03: the backend is not trusted with payer, payee and amounts: sign only the bundle that the local `planOffer` gives for this listing and this offer
    const view = (await this.book.listings({ status: "all" })).find((l) => l.listingHash === listingHashHex);
    const accepted = (await this.book.offersOf(listingHashHex)).find((o) => o.offerHash === offerHashHex);
    if (!view || !accepted) throw new Error("bundle_not_verified: the listing or the offer is not in the book");
    const offer: Offer = {
      circle: this.#contractId, listing_hash: view.listingHash, proposer: accepted.proposer, round: accepted.round, mode: accepted.mode,
      value: accepted.value, quantity: accepted.quantity, deliver_by: Math.floor(Date.parse(accepted.deliverBy) / 1000),
    };
    // The backend may know a referral that this call did not name (the offer cites it): the searcher is then the payee of the bundle that is neither the seller nor the counterparty.
    // Its share must come out of the discount of the listing (never above `discount_bps`) and must reproduce the same terms hash through the local `planOffer`.
    const listing = this.#toListing(view);
    const others = [...new Set(preview.bundle.terms.legs.map((l) => l.payee))].filter((p) => p !== view.account && p !== accepted.counterparty);
    const searcher = referral?.searcher ?? (others.length === 1 ? others[0] : undefined);
    const shares: number[] = [];
    if (referral) shares.push(referral.searcherShareBps);
    else if (searcher !== undefined) {
      const leg = preview.bundle.terms.legs.find((l) => l.payee === searcher);
      for (const denominator of [BigInt(accepted.value), BigInt(view.offer.value)]) {
        const base = leg ? Number((BigInt(leg.max_amount) * BPS) / denominator) : 0;
        shares.push(base, base + 1);
      }
    } else shares.push(0);
    let why = "the legs of the server do not match the listing and the offer";
    let matched = false;
    if (others.length <= 1) {
      for (const share of shares) {
        if (searcher !== undefined && share > view.discountBps) continue;
        try {
          const plan = planOffer({ listing, offer, epoch: preview.epoch, counterparty: accepted.counterparty, ...(searcher === undefined ? {} : { searcher, searcherShareBps: share }) });
          if (plan.kind === "bundle" && plan.terms_hash === preview.bundle.termsHash) {
            matched = true;
            break;
          }
        } catch (error) {
          why = `the local plan fails: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } else why = "the bundle pays more than one party besides the seller and the counterparty";
    if (!matched) throw new Error(`bundle_differs_from_local_plan: ${why}; not signed`);
    // reserve before the first await: a signing that runs at the same time must see this one in the count
    const over = this.#limit.reserve(preview.bundle.terms);
    if (over) throw new Error(`${over}: the bundle pays more than the owner allows; not signed`);
    try {
      const { signature } = signBundle(preview.bundle.terms, account, this.identity.voucherSecretKey);
      return await this.book.accept(listingHashHex, offerHashHex, { account, epoch: preview.epoch, signature, ...seeker });
    } catch (error) {
      this.#limit.release(preview.bundle.terms);
      throw error;
    }
  }
}
