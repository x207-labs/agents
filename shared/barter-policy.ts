// Kebijakan marketplace agent (AG-016, F9): membuat listing dari barang dan kebutuhan pemilik, menilai tawaran, tawar balik, terima atau tolak.
// Keputusan dasar adalah aturan deterministik dari kebijakan pemilik ("mode mock"). Dengan klien LLM `live`, model boleh mengusulkan
// keputusan, tetapi usulan yang melanggar batas kebijakan (nilai di bawah lantai atau di atas plafon, kata aksi tak dikenal) dibuang
// dan aturan dasar yang dipakai: kebijakan pemilik selalu menang atas keluaran model.
import {
  ASSET_CLASSES, listingHash, planOffer, signBundle, signListing, signOffer, signReferral, signRefuseReferral, termsHash,
  type AssetClass, type Listing, type Offer, type Referral,
} from "@x207/core";
import { BookClient, type AcceptResult, type ListingView, type OfferView, type ReferralView } from "./barter.ts";
import type { SeekerPlan } from "./seeker.ts";
import type { AgentIdentity } from "./identity.ts";
import type { LlmClient } from "./nearai.ts";

/** Barang yang pemilik punya dan boleh dilepas. `unitValue` dalam credit satuan terkecil per unit. */
export type Holding = { assetType: string; assetClass: AssetClass; quantity: number; unitValue: string };
/** Kebutuhan pemilik; `maxUnitValue` batas harga per unit yang mau dibayar. */
export type Need = { assetType: string; assetClass: AssetClass; quantity: number; maxUnitValue: string };

export type BarterPolicy = {
  holdings: Holding[];
  needs: Need[];
  /** Diskon barter cepat pada listing, bps dari nilai `offer`. */
  discountBps: number;
  acceptPayment: boolean;
  discoverable: boolean;
  listingTtlSeconds: number;
  /** Penjual: terima tawaran bernilai paling sedikit bagian ini dari nilai `offer` listing (bps). */
  minAcceptBps: number;
  /** Penjual: tolak langsung tawaran di bawah bagian ini (bps), tanpa tawar balik. */
  rejectBelowBps: number;
  /** Penawar: tawaran pembuka sebagai bagian dari nilai `offer` listing (bps). */
  openingBps: number;
  /** Besar konsesi per ronde (bps dari nilai `offer` listing). */
  stepBps: number;
  maxRounds: number;
  /** Opt-in ajakan pencari (SV-016): tanpa ini setiap ajakan di kotak masuk ditolak. */
  acceptReferrals: boolean;
  /** Penjual: batas jumlah per pesanan tidak boleh melebihi listing; selalu berlaku. */
  deliverDays: number;
};

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
  /** Peran agent dalam utas ini. */
  role: "seller" | "buyer";
  listing: Pick<Listing, "offer" | "want" | "accept_payment" | "expires_at">;
  /** Tawaran yang masuk dan menunggu jawaban agent ini. */
  offer: Pick<Offer, "round" | "mode" | "value" | "quantity">;
  /** Nilai tawaran terakhir milik agent sendiri di utas ini (penawar), bila ada. */
  ownLastValue?: string;
  policy: BarterPolicy;
  /** Detik unix. */
  now: number;
};

/** Aturan dasar. Penjual: terima di atas lantai, tolak di bawah batas bawah, selain itu tawar balik turun dari harga listing per ronde. */
export function decideRule(ctx: DecisionContext): Decision {
  const { listing, offer, policy } = ctx;
  const listed = BigInt(listing.offer.value);
  const value = BigInt(offer.value);
  if (listing.expires_at <= ctx.now) return { action: "reject", reason: "listing_expired" };
  if (offer.mode === "pay" && !listing.accept_payment) return { action: "reject", reason: "payment_not_accepted" };

  if (ctx.role === "seller") {
    if (offer.quantity > listing.offer.quantity) return { action: "reject", reason: "quantity_exceeds_listing" };
    const floor = bps(listed, policy.minAcceptBps);
    if (value >= floor) return { action: "accept" };
    if (value < bps(listed, policy.rejectBelowBps)) return { action: "reject", reason: "too_low" };
    if (offer.round >= policy.maxRounds) return { action: "reject", reason: "max_rounds" };
    // Konsesi mulai dari harga listing: ronde 2 menurunkan satu langkah, dst., tidak pernah di bawah lantai.
    const asked = listed - bps(listed, policy.stepBps) * BigInt(Math.max(1, Math.floor(offer.round / 2)));
    const counter = asked > floor ? asked : floor;
    return counter <= value ? { action: "accept" } : { action: "counter", value: counter.toString() };
  }

  // Penawar menilai tawaran balik penjual: terima bila tidak melebihi plafon kebutuhan.
  const need = policy.needs.find((n) => n.assetType === listing.offer.asset_type);
  const ceiling = need ? BigInt(need.maxUnitValue) * BigInt(Math.min(need.quantity, listing.offer.quantity)) : bps(listed, policy.minAcceptBps);
  const cap = ceiling < listed ? ceiling : listed;
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
    // Menerima tawaran di bawah lantai penjual atau di atas plafon penawar melanggar kebijakan.
    return decideRule(ctx).action === "accept";
  }
  if (!/^[1-9]\d*$/.test(decision.value)) return false;
  const value = BigInt(decision.value);
  return ctx.role === "seller" ? value >= bps(listed, ctx.policy.minAcceptBps) && value <= listed : value > 0n && value <= listed;
}

/** Keputusan LLM live bila sah menurut kebijakan; selain itu aturan dasar. */
export async function decide(ctx: DecisionContext, llm?: LlmClient): Promise<Decision & { source: "rule" | "llm" }> {
  const base = decideRule(ctx);
  if (!llm || llm.mode !== "live") return { ...base, source: "rule" };
  const system =
    'You decide for a barter agent. Reply with JSON only: {"action":"accept"}, {"action":"counter","value":"<integer>"} or {"action":"reject","reason":"<short>"}. ' +
    "Amounts are integers in credit micro-units. Respect the owner policy exactly.";
  const input = JSON.stringify({ role: ctx.role, listing: ctx.listing, offer: ctx.offer, ownLastValue: ctx.ownLastValue, policy: ctx.policy, ruleSuggestion: base });
  try {
    const raw = await llm.complete(system, input);
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Decision;
    if (parsed && ["accept", "counter", "reject"].includes(parsed.action) && validAgainstPolicy(parsed, ctx)) return { ...parsed, source: "llm" };
  } catch {
    // keluaran model tidak terbaca: pakai aturan dasar
  }
  return { ...base, source: "rule" };
}

const NONCE = /[^A-Za-z0-9_-]/g;

/** Listing dari satu barang dan satu kebutuhan pemilik; nilai = harga satuan × jumlah. */
export function buildListing(args: {
  identity: AgentIdentity;
  contractId: string;
  policy: BarterPolicy;
  now: number;
  nonce: string;
  holding?: number;
  need?: number;
}): Listing {
  const holding = args.policy.holdings[args.holding ?? 0];
  const need = args.policy.needs[args.need ?? 0];
  if (!holding) throw new Error("kebijakan tidak punya barang untuk dilisting");
  if (!need) throw new Error("kebijakan tidak punya kebutuhan untuk dicari");
  for (const item of [holding, need]) {
    if (!(ASSET_CLASSES as readonly string[]).includes(item.assetClass)) throw new Error(`kelas aset ${item.assetClass} tidak boleh dilisting`);
  }
  return {
    circle: args.contractId,
    account: args.identity.accountId,
    offer: { asset_type: holding.assetType, asset_class: holding.assetClass, quantity: holding.quantity, value: String(BigInt(holding.unitValue) * BigInt(holding.quantity)) },
    want: { asset_type: need.assetType, asset_class: need.assetClass, quantity: need.quantity, value: String(BigInt(need.maxUnitValue) * BigInt(need.quantity)) },
    terms: "delivery as agreed in the accepted offer",
    detail: `${holding.assetType} for ${need.assetType}`,
    expires_at: args.now + args.policy.listingTtlSeconds,
    discount_bps: args.policy.discountBps,
    accept_payment: args.policy.acceptPayment,
    discoverable: args.policy.discoverable,
    nonce: args.nonce.replace(NONCE, "-").slice(0, 64),
  };
}

/** Listing dari buku yang cocok dengan kebutuhan agent: `offer` listing = kebutuhan dan `want` listing = barang yang agent punya. */
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
};

/** Agent yang menjalankan kebijakan marketplace pemiliknya terhadap buku listing. */
export class PolicyAgent {
  readonly identity: AgentIdentity;
  readonly book: BookClient;
  readonly policy: BarterPolicy;
  readonly #contractId: string;
  readonly #llm: LlmClient | undefined;
  readonly #now: () => number;
  readonly #listings = new Map<string, Listing>();
  readonly #ownLast = new Map<string, string>();
  #counter = 0;

  constructor(options: PolicyAgentOptions) {
    this.identity = options.identity;
    this.book = options.book;
    this.policy = options.policy;
    this.#contractId = options.contractId;
    this.#llm = options.llm;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Pasang listing dari barang dan kebutuhan pemilik. */
  async list(holding = 0, need = 0): Promise<{ listing: Listing; hash: string }> {
    const nonce = `${this.identity.accountId.split(".")[0]}-${this.#now()}-${(this.#counter += 1)}`;
    const listing = buildListing({ identity: this.identity, contractId: this.#contractId, policy: this.policy, now: this.#now(), nonce, holding, need });
    await this.book.postListing(listing, signListing(listing, this.identity.voucherSecretKey));
    const hash = listingHash(listing);
    this.#listings.set(hash, listing);
    return { listing, hash };
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
   * Pencari: tandatangani ajakan dari rencana `SeekerBot` dan kirim ke kotak masuk agent tujuan. Penawarannya tetap harus ditandatangani
   * agent tujuan sendiri (`handleReferrals`). `ttlSeconds` default 1 jam.
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
   * Agent tujuan: jawab ajakan di kotak masuk. Ajakan yang cocok dengan kebutuhan agent dan kebijakan `acceptReferrals` dijawab dengan
   * penawaran ronde 1 buatan agent sendiri yang merujuk ajakan (jatah pencari melekat di utas); selain itu ditolak dengan tanda tangan.
   */
  async handleReferrals(): Promise<Array<{ referralHash: string; action: "bid" | "refused"; reason?: string; offerHash?: string }>> {
    const answers: Array<{ referralHash: string; action: "bid" | "refused"; reason?: string; offerHash?: string }> = [];
    const open = await this.book.listings({ status: "open" });
    for (const referral of await this.book.referralInbox(this.identity.accountId)) {
      const view = open.find((l) => l.listingHash === referral.listingHash);
      const fit = view ? matchesPolicy(view, this.identity.accountId, this.policy) : null;
      const reason = !this.policy.acceptReferrals ? "not_opted_in" : !view ? "listing_gone" : fit === null ? "no_need" : referral.mode === "barter" && fit !== "barter" ? "no_goods" : undefined;
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

  /** Cari listing yang cocok dengan kebutuhan dan ajukan tawaran pembuka (ronde 1). */
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
   * Kirim penawaran ronde 1 dari ajakan pencari (SV-015): nilai = nilai listing, cara dan jumlah dari rencana pencari. Hanya agent
   * yang sudah opt-in yang memanggil ini; penawaran ditandatangani agent sendiri.
   */
  async bidFromReferral(plan: { listing: ListingView; mode: "pay" | "barter"; value: string; quantity: number }): Promise<StepResult> {
    const offer = await this.#postOffer(plan.listing, 1, plan.mode, plan.value, plan.quantity);
    return { kind: "bid", listingHash: plan.listing.listingHash, offerHash: offer.offerHash, mode: plan.mode, value: plan.value };
  }

  /**
   * Jawab penawaran di kotak masuk menurut kebijakan: terima, tawar balik, atau tolak. `referral` menyebut pencari yang membawa
   * penawaran itu (bila ada); jatahnya menjadi leg di bundle yang sama.
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
   * Tandatangani usulan bundle dari negosiasi agent ini hanya bila syaratnya sama dengan hitungan lokal `planOffer` atas listing dan
   * penawaran yang diterima (jatah pencari dibaca dari leg pencari). Usulan lain ditolak.
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
      // Jatah pencari dihitung dari nilai kesepakatan (Offer.value penawaran yang diterima).
      const listed = BigInt(accepted.value);
      const base = leg ? Number((BigInt(leg.max_amount) * BPS) / listed) : 0;
      // Pembulatan ke bawah saat server menghitung jatah: coba bps terdekat yang menghasilkan jumlah leg yang sama.
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
      await this.book.signProposal(proposal.termsHash, account, signBundle(proposal.terms, account, this.identity.voucherSecretKey).signature);
      answers.push({ termsHash: proposal.termsHash, action: "signed" });
    }
    return answers;
  }

  async #accept(listingHashHex: string, offerHashHex: string, referral?: { searcher: string; searcherShareBps: number }): Promise<AcceptResult> {
    const account = this.identity.accountId;
    const seeker = referral ? { searcher: referral.searcher, searcherShareBps: referral.searcherShareBps } : {};
    const preview = await this.book.previewAccept(listingHashHex, offerHashHex, { account, ...seeker });
    if (!preview.bundle) return this.book.accept(listingHashHex, offerHashHex, { account, epoch: preview.epoch, ...seeker });
    if (termsHash(preview.bundle.terms) !== preview.bundle.termsHash) throw new Error("terms_hash dari server tidak cocok dengan syarat bundle");
    const { signature } = signBundle(preview.bundle.terms, account, this.identity.voucherSecretKey);
    return this.book.accept(listingHashHex, offerHashHex, { account, epoch: preview.epoch, signature, ...seeker });
  }
}
