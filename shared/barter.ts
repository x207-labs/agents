// Barter dan marketplace untuk agent (AG-012, F5/F9): klien buku backend (M11), pengiriman intent offer/need, evaluasi usulan bundle
// terhadap intent sendiri, dan tanda tangan `terms_hash` dengan kunci voucher. Hanya paket publik @x207/core yang dipakai (AG-006);
// agent tidak pernah mengirim transaksi, jadi argumen `post_intent` dikembalikan ke pemanggil yang memegang pengirim transaksi.
import {
  bundleParticipants, intentHash, intentHashBase58, signBundle, signIntent, termsHash,
  type BarterIntent, type BarterSide, type BundleTerms, type Listing, type Offer,
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
  /** Contoh `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Id lingkaran di path, mis. `agents-main`. */
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

export type EpochSummary = { epoch: number; phase: string };

/** Klien tipis atas read API dan buku marketplace; satu instance per lingkaran. */
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
  /** Kotak masuk: penawaran yang menunggu jawaban `account`. */
  async inbox(account: string): Promise<OfferView[]> {
    return (await this.get<{ items: OfferView[] }>(`/offers?account=${encodeURIComponent(account)}&box=inbox`)).items;
  }
  postOffer(listingHash: string, offer: Offer, signature: string, inReplyTo?: string): Promise<OfferView> {
    return this.post<OfferView>(`/listings/${listingHash}/offers`, { offer, signature, ...(inReplyTo ? { inReplyTo } : {}) });
  }
  previewAccept(listingHash: string, offerHash: string, body: { account: string; searcher?: string; searcherShareBps?: number }): Promise<AcceptPreview> {
    return this.post<AcceptPreview>(`/listings/${listingHash}/offers/${offerHash}/preview`, body);
  }
  accept(listingHash: string, offerHash: string, body: { account: string; signature?: string; epoch?: number; searcher?: string; searcherShareBps?: number }): Promise<AcceptResult> {
    return this.post<AcceptResult>(`/listings/${listingHash}/offers/${offerHash}/accept`, body);
  }
  /** Epoch `open` saat ini, atau `null` bila tidak ada. */
  async openEpoch(): Promise<number | null> {
    const epochs = (await this.get<{ items: EpochSummary[] }>("/epochs")).items;
    return epochs.find((e) => e.phase === "open")?.epoch ?? null;
  }
}

export type Evaluation =
  | { ok: true; intentHash: string }
  | { ok: false; reason: "terms_hash_mismatch" | "wrong_circle" | "not_participant" | "epoch_mismatch" | "no_open_intent" | "no_leg" | "underpaid" | "overpay" };

const sum = (values: Iterable<string>): bigint => [...values].reduce((total, v) => total + BigInt(v), 0n);

/**
 * Apakah usulan bundle cocok dengan salah satu intent terbuka milik `account`? Aturan: hash dihitung ulang dari syarat, lingkaran dan epoch
 * sama, `account` ikut serta, jumlah yang diterima sebagai payee minimal `offer.value` dan jumlah yang dibayar sebagai payer paling banyak
 * `need.value`. Intent yang sudah kedaluwarsa tidak dipakai. Mengembalikan alasan penolakan dari intent yang paling dekat cocok.
 */
export function evaluateProposal(args: {
  account: string;
  proposal: Pick<BundleProposalView, "termsHash" | "terms">;
  intents: readonly BarterIntent[];
  /** Detik unix. */
  now: number;
  /** Epoch `open` saat ini bila diketahui; tanpa ini epoch tidak diperiksa. */
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
  /** Akun kontrak lingkaran (penerima NEP-413), mis. `x207-circle.near`. */
  contractId: string;
  /** Detik unix; bisa diganti di test. */
  now?: () => number;
};

/** Agent yang memasang intent offer/need dan menandatangani usulan bundle yang cocok dengan intent-nya. */
export class BarterAgent {
  readonly identity: AgentIdentity;
  readonly book: BookClient;
  readonly #contractId: string;
  readonly #now: () => number;
  readonly #intents = new Map<string, BarterIntent>();

  constructor(options: BarterAgentOptions) {
    this.identity = options.identity;
    this.book = options.book;
    this.#contractId = options.contractId;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get intents(): BarterIntent[] {
    return [...this.#intents.values()];
  }

  /** Tandatangani dan kirim intent `offer` (yang agent sediakan) dan `need` (yang dibutuhkan); `ttlSeconds` default 1 jam. */
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

  /** Argumen `post_intent` untuk intent yang sudah dikirim; pemegang transaksi mengirimnya. */
  postIntentArgs(intent: BarterIntent): { intent_hash: string } {
    return { intent_hash: intentHashBase58(intent) };
  }

  /** Nilai evaluasi satu usulan terhadap intent sendiri, tanpa menandatangani. */
  async evaluate(proposal: BundleProposalView): Promise<Evaluation> {
    const openEpoch = await this.book.openEpoch();
    return evaluateProposal({ account: this.identity.accountId, proposal, intents: this.intents, now: this.#now(), openEpoch });
  }

  /** Ambil usulan yang menunggu tanda tangan agent ini; tandatangani yang cocok dengan intent, tolak sisanya. */
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
      answers.push({ termsHash: proposal.termsHash, action: "signed" });
    }
    return answers;
  }
}
