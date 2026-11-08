// Barter and marketplace for agents (AG-012, F5/F9): backend book client (M11), sending offer/need intents, evaluating bundle proposals
// against the agent's own intents, and signing `terms_hash` with the voucher key. Only the public @x207/core package is used (AG-006);
// the agent never sends transactions, so the `post_intent` arguments are returned to the caller that holds the transaction sender.
import {
  bundleParticipants, intentHash, intentHashBase58, signBundle, signIntent, termsHash,
  type BarterIntent, type BarterSide, type BundleSignature, type BundleTerms, type Listing, type Offer, type Referral,
} from "@x207/core";
import type { AgentIdentity } from "./identity.ts";

export class BookError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BookError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type BookOptions = {
  /** Example `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Circle id in the path, e.g. `agents-main`. */
  circleId: string;
  fetch?: typeof fetch;
};

export type IntentView = {
  intentHash: string;
  intentHashBase58: string;
  account: string;
  offer: BarterSide;
  need: BarterSide;
  expiresAt: string;
  status: string;
  onchain: { method: "post_intent"; args: { intent_hash: string }; posted: boolean; blockHeight?: number };
};

export type BundleProposalView = {
  termsHash: string;
  status: "proposed" | "ready";
  epoch: number;
  terms: BundleTerms;
  participants: string[];
  signatures: Array<{ account: string; signature: string }>;
  missing: string[];
  listingHash: string | null;
};

export type ListingView = {
  listingHash: string;
  account: string;
  offer: { assetType: string; assetClass: string; quantity: number; value: string };
  want: { assetType: string; assetClass: string; quantity: number; value: string };
  terms: string;
  detail: string;
  expiresAt: string;
  discountBps: number;
  acceptPayment: boolean;
  discoverable: boolean;
  nonce: string;
  status: string;
};

export type OfferView = {
  offerHash: string;
  listingHash: string;
  proposer: string;
  counterparty: string;
  awaiting: string;
  round: number;
  mode: "pay" | "barter";
  value: string;
  quantity: number;
  deliverBy: string;
  status: string;
};

export type AcceptPreview = {
  kind: "payment" | "bundle";
  epoch: number;
  mode: "pay" | "barter";
  discountValue: string;
  searcherValue: string;
  breakdown: Record<string, string>;
  bundle: { termsHash: string; message: string; recipient: string; terms: BundleTerms; participants: string[] } | null;
  payment: { payer: string; payee: string; amount: string } | null;
};

export type AcceptResult = {
  match: { kind: "payment" | "bundle"; termsHash: string | null };
  result: { kind: "payment"; payer: string; payee: string; amount: string } | { kind: "bundle"; proposal: BundleProposalView };
};

export type ReferralView = {
  referralHash: string;
  seeker: string;
  to: string;
  listingHash: string;
  mode: "pay" | "barter";
  value: string;
  quantity: number;
  deliverBy: string;
  searcherShareBps: number;
  expiresAt: string;
  status: string;
  offerHash: string | null;
};

export type EpochSummary = { epoch: number; phase: string };

/** Thin client over the read API and the marketplace book; one instance per circle. */
export class BookClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly circleId: string;

  constructor(options: BookOptions) {
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.circleId = options.circleId;
    this.#fetch = options.fetch ?? fetch;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#base}/x207/circles/${encodeURIComponent(this.circleId)}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    if (!response.ok) {
      const error = payload?.error;
      throw new BookError(response.status, error?.code ?? "http_error", error?.message ?? `HTTP ${response.status}`, error?.details ?? {});
    }
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  postIntent(intent: BarterIntent, signature: string): Promise<IntentView> {
    return this.post<IntentView>("/intents", { intent, signature });
  }
  async listIntents(status: "open" | "matched" | "expired" | "all" = "open"): Promise<IntentView[]> {
    return (await this.get<{ items: IntentView[] }>(`/intents?status=${status}`)).items;
  }
  async proposals(account: string, status: "proposed" | "ready" | "all" = "proposed"): Promise<BundleProposalView[]> {
    return (await this.get<{ items: BundleProposalView[] }>(`/bundle-proposals?status=${status}&account=${encodeURIComponent(account)}`)).items;
  }
  signProposal(termsHash: string, account: string, signature: string): Promise<BundleProposalView> {
    return this.post<BundleProposalView>(`/bundle-proposals/${termsHash}/signatures`, { account, signature });
  }
  postListing(listing: Listing, signature: string): Promise<ListingView> {
    return this.post<ListingView>("/listings", { listing, signature });
  }
  async listings(query: Record<string, string> = { status: "open" }): Promise<ListingView[]> {
    return (await this.get<{ items: ListingView[] }>(`/listings?${new URLSearchParams(query).toString()}`)).items;
  }
  async offersOf(listingHash: string): Promise<OfferView[]> {
    return (await this.get<{ items: OfferView[] }>(`/listings/${listingHash}/offers`)).items;
  }
  /** Inbox: offers waiting for an answer from `account`. */
  async inbox(account: string): Promise<OfferView[]> {
    return (await this.get<{ items: OfferView[] }>(`/offers?account=${encodeURIComponent(account)}&box=inbox`)).items;
  }
  postOffer(listingHash: string, offer: Offer, signature: string, inReplyTo?: string, referralHash?: string): Promise<OfferView> {
    return this.post<OfferView>(`/listings/${listingHash}/offers`, {
      offer, signature, ...(inReplyTo ? { inReplyTo } : {}), ...(referralHash ? { referralHash } : {}),
    });
  }
  /** Bundle proposals from the solver with no listing match (SV-011): the server recomputes `terms_hash` and checks that the epoch is open. */
  postBundleProposal(terms: BundleTerms): Promise<BundleProposalView> {
    return this.post<BundleProposalView>("/bundle-proposals", { terms, termsHash: termsHash(terms) });
  }
  postReferral(referral: Referral, signature: string): Promise<ReferralView> {
    return this.post<ReferralView>("/referrals", { referral, signature });
  }
  /** Inbox of seeker referrals still pending for `account`. */
  async referralInbox(account: string): Promise<ReferralView[]> {
    return (await this.get<{ items: ReferralView[] }>(`/referrals?account=${encodeURIComponent(account)}&box=inbox`)).items;
  }
  refuseReferral(referralHash: string, signature: string): Promise<ReferralView> {
    return this.post<ReferralView>(`/referrals/${referralHash}/refuse`, { signature });
  }
  previewAccept(listingHash: string, offerHash: string, body: { account: string; searcher?: string; searcherShareBps?: number }): Promise<AcceptPreview> {
    return this.post<AcceptPreview>(`/listings/${listingHash}/offers/${offerHash}/preview`, body);
  }
  accept(listingHash: string, offerHash: string, body: { account: string; signature?: string; epoch?: number; searcher?: string; searcherShareBps?: number }): Promise<AcceptResult> {
    return this.post<AcceptResult>(`/listings/${listingHash}/offers/${offerHash}/accept`, body);
  }
  /** The current `open` epoch, or `null` if there is none. */
  async openEpoch(): Promise<number | null> {
    const epochs = (await this.get<{ items: EpochSummary[] }>("/epochs")).items;
    return epochs.find((e) => e.phase === "open")?.epoch ?? null;
  }
}

export type Evaluation =
  | { ok: true; intentHash: string }
  | { ok: false; reason: "terms_hash_mismatch" | "wrong_circle" | "not_participant" | "epoch_mismatch" | "no_open_intent" | "no_leg" | "underpaid" | "overpay" | "over_owner_limit" };

const sum = (values: Iterable<string>): bigint => [...values].reduce((total, v) => total + BigInt(v), 0n);

/**
 * Does a bundle proposal match one of the open intents owned by `account`? Rules: the hash is recomputed from the terms, the circle and epoch are the
 * same, `account` takes part, the amount received as payee is at least `offer.value` and the amount paid as payer is at most
 * `need.value`. Expired intents are not used. Returns the rejection reason from the closest matching intent.
 */
export function evaluateProposal(args: {
  account: string;
  proposal: Pick<BundleProposalView, "termsHash" | "terms">;
  intents: readonly BarterIntent[];
  /** Detik unix. */
  now: number;
  /** The current `open` epoch if known; without it the epoch is not checked. */
  openEpoch?: number | null;
}): Evaluation {
  const { account, proposal, intents } = args;
  if (termsHash(proposal.terms) !== proposal.termsHash) return { ok: false, reason: "terms_hash_mismatch" };
  if (!bundleParticipants(proposal.terms).includes(account)) return { ok: false, reason: "not_participant" };
  if (args.openEpoch !== undefined && args.openEpoch !== null && proposal.terms.epoch !== args.openEpoch) return { ok: false, reason: "epoch_mismatch" };
  const live = intents.filter((i) => i.account === account && i.expiresAt > args.now);
  if (live.length === 0) return { ok: false, reason: "no_open_intent" };
  const sameCircle = live.filter((i) => i.circle === proposal.terms.circle);
  if (sameCircle.length === 0) return { ok: false, reason: "wrong_circle" };
  const incoming = sum(proposal.terms.legs.filter((l) => l.payee === account).map((l) => l.max_amount));
  const outgoing = sum(proposal.terms.legs.filter((l) => l.payer === account).map((l) => l.max_amount));
  if (incoming === 0n || outgoing === 0n) return { ok: false, reason: "no_leg" };
  let reason: "underpaid" | "overpay" = "underpaid";
  for (const intent of sameCircle) {
    const paid = incoming >= BigInt(intent.offer.value);
    const affordable = outgoing <= BigInt(intent.need.value);
    if (paid && affordable) return { ok: true, intentHash: intentHash(intent) };
    if (paid && !affordable) reason = "overpay";
  }
  return { ok: false, reason };
}

export type ProposalAnswer = { termsHash: string; action: "signed" | "rejected"; reason?: string };

export type BarterAgentOptions = {
  identity: AgentIdentity;
  book: BookClient;
  /** Circle contract account (NEP-413 recipient), e.g. `x207-circle.near`. */
  contractId: string;
  /** Unix seconds; can be replaced in tests. */
  now?: () => number;
  /**
   * What the owner lets this agent commit to pay in bundles per epoch (the legs where it is the payer, smallest unit). Not the `maxPerEpoch` of the spend policy: that one bounds
   * micro payments, a bundle leg is a settlement cap of another scale, and reusing it would refuse every normal barter. Without it, bundles are bounded only by the intents (AG-046).
   */
  maxBundlePerEpoch?: string;
};

/** An agent that places offer/need intents and signs the bundle proposals that match its intents. */
export class BarterAgent {
  readonly identity: AgentIdentity;
  readonly book: BookClient;
  readonly #contractId: string;
  readonly #now: () => number;
  readonly #intents = new Map<string, BarterIntent>();
  /** What the agent has already signed to pay, per epoch (the legs where it is the payer), for `maxBundlePerEpoch`. */
  readonly #committed = new Map<number, bigint>();
  readonly #maxBundlePerEpoch: bigint | null;

  constructor(options: BarterAgentOptions) {
    this.#maxBundlePerEpoch = options.maxBundlePerEpoch === undefined ? null : BigInt(options.maxBundlePerEpoch);
    this.identity = options.identity;
    this.book = options.book;
    this.#contractId = options.contractId;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get intents(): BarterIntent[] {
    return [...this.#intents.values()];
  }

  /** Sign and send an `offer` intent (what the agent provides) and a `need` intent (what it requires); `ttlSeconds` defaults to 1 hour. */
  async postIntent(offer: BarterSide, need: BarterSide, ttlSeconds = 3600): Promise<{ intent: BarterIntent; view: IntentView }> {
    const intent: BarterIntent = {
      circle: this.#contractId,
      account: this.identity.accountId,
      offer,
      need,
      expiresAt: this.#now() + ttlSeconds,
      nonce: `${this.identity.accountId.split(".")[0]}-${this.#now()}-${this.#intents.size}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64),
    };
    const view = await this.book.postIntent(intent, signIntent(intent, this.identity.voucherSecretKey));
    this.#intents.set(intentHash(intent), intent);
    return { intent, view };
  }

  /** The `post_intent` arguments for an intent that was already sent; the transaction holder submits them. */
  postIntentArgs(intent: BarterIntent): { intent_hash: string } {
    return { intent_hash: intentHashBase58(intent) };
  }

  /** The legs where this agent pays, summed. */
  #payLegs(terms: BundleTerms): bigint {
    return sum(terms.legs.filter((l) => l.payer === this.identity.accountId).map((l) => l.max_amount));
  }
  /** `maxBundlePerEpoch` of the owner: what was signed before in this epoch plus this bundle must stay within it. */
  #overOwnerLimit(terms: BundleTerms): boolean {
    return this.#maxBundlePerEpoch !== null && (this.#committed.get(terms.epoch) ?? 0n) + this.#payLegs(terms) > this.#maxBundlePerEpoch;
  }
  #commit(terms: BundleTerms): void {
    this.#committed.set(terms.epoch, (this.#committed.get(terms.epoch) ?? 0n) + this.#payLegs(terms));
  }

  /** Evaluate one proposal against the agent's own intents and the owner's epoch limit, without signing. */
  async evaluate(proposal: BundleProposalView): Promise<Evaluation> {
    const openEpoch = await this.book.openEpoch();
    const verdict = evaluateProposal({ account: this.identity.accountId, proposal, intents: this.intents, now: this.#now(), openEpoch });
    return verdict.ok && this.#overOwnerLimit(proposal.terms) ? { ok: false, reason: "over_owner_limit" } : verdict;
  }

  /**
   * Signature request from the solver (SV-011): the bundle terms arrive directly, not through the book. The agent signs `terms_hash`
   * only if the terms match its open intent (same rules as `answerProposals`); otherwise `null`.
   */
  async signTerms(terms: BundleTerms): Promise<BundleSignature | null> {
    const openEpoch = await this.book.openEpoch();
    const verdict = evaluateProposal({
      account: this.identity.accountId, proposal: { termsHash: termsHash(terms), terms }, intents: this.intents, now: this.#now(), openEpoch,
    });
    if (!verdict.ok || this.#overOwnerLimit(terms)) return null;
    const signed = signBundle(terms, this.identity.accountId, this.identity.voucherSecretKey);
    this.#commit(terms);
    this.#intents.delete(verdict.intentHash); // A-AG-07: one intent, one signed bundle
    return signed;
  }

  /** Fetch the proposals waiting for this agent's signature; sign those that match an intent, reject the rest. */
  async answerProposals(): Promise<ProposalAnswer[]> {
    const account = this.identity.accountId;
    const answers: ProposalAnswer[] = [];
    for (const proposal of await this.book.proposals(account, "proposed")) {
      if (!proposal.missing.includes(account)) continue;
      const verdict = await this.evaluate(proposal);
      if (!verdict.ok) {
        answers.push({ termsHash: proposal.termsHash, action: "rejected", reason: verdict.reason });
        continue;
      }
      const { signature } = signBundle(proposal.terms, account, this.identity.voucherSecretKey);
      await this.book.signProposal(proposal.termsHash, account, signature);
      this.#commit(proposal.terms);
      this.#intents.delete(verdict.intentHash); // A-AG-07: one intent, one signed bundle; a second proposal for the same need is no longer matched
      answers.push({ termsHash: proposal.termsHash, action: "signed" });
    }
    return answers;
  }
}
