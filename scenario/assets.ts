// Skenario aset beragam (AG-019, F9): compute, data, akses akun, dan aset yang dialihkan native dicocokkan lewat buku marketplace,
// sedangkan kelas `X` ditolak. Setiap pasangan berjalan dengan `PolicyAgent` (AG-016): listing, tawaran, tawar balik, terima, lalu
// kedua pihak menandatangani bundle. Pencocokan di sini lewat listing yang saling melengkapi; solver (SV-013) akan mengambil alih.
import { signListing, type Listing } from "@x207/core";
import { BookClient, BookError } from "../shared/barter.ts";
import { DEFAULT_BARTER_POLICY, PolicyAgent, type BarterPolicy, type Holding, type Need } from "../shared/barter-policy.ts";
import type { AgentIdentity } from "../shared/identity.ts";

const CREDIT = 1_000_000;

export type AssetPair = {
  seller: string;
  buyer: string;
  /** Yang dijual `seller` dan dicari `buyer`. */
  sold: Holding;
  /** Yang dijual `buyer` dan dicari `seller`. */
  paid: Holding;
  /** Harga satuan tertinggi yang mau dibayar `buyer` untuk `sold`; default `sold.unitValue`. */
  buyerMaxUnitValue?: string;
};

const unit = (credits: number): string => String(credits * CREDIT);

/** Tiga pasangan lintas kelas: compute (D) ↔ data (C), akses akun (B) ↔ jasa (D), aset native (A) ↔ data (C). */
export const ASSET_PAIRS: readonly AssetPair[] = [
  {
    seller: "gpu",
    buyer: "scraper",
    sold: { assetType: "compute:gpu-h100-hours", assetClass: "D", quantity: 10, unitValue: unit(10) },
    paid: { assetType: "data:web-crawl-2026", assetClass: "C", quantity: 10, unitValue: unit(10) },
  },
  {
    seller: "translator",
    buyer: "summarizer",
    sold: { assetType: "access:repo-write-key", assetClass: "B", quantity: 5, unitValue: unit(20) },
    paid: { assetType: "service:summarize-calls", assetClass: "D", quantity: 5, unitValue: unit(20) },
  },
  {
    seller: "image",
    buyer: "cleaner",
    sold: { assetType: "nft:render-license", assetClass: "A", quantity: 1, unitValue: unit(100) },
    paid: { assetType: "data:cleaned-dataset", assetClass: "C", quantity: 1, unitValue: unit(100) },
  },
];

export type PairOutcome = {
  seller: string;
  buyer: string;
  soldType: string;
  soldClass: string;
  paidType: string;
  paidClass: string;
  listingHash: string;
  /** Urutan langkah negosiasi, mis. `bid`, `countered`, `accepted`. */
  steps: string[];
  bundle: { termsHash: string; status: string; participants: number } | null;
};

export type RejectedOutcome = { assetType: string; assetClass: string; code: string; message: string; allowed: unknown };

export type AssetScenarioReport = {
  pairs: PairOutcome[];
  rejected: RejectedOutcome[];
  classes: string[];
};

const policyFor = (side: Holding, other: Holding, maxUnitValue = other.unitValue): BarterPolicy => ({
  ...DEFAULT_BARTER_POLICY,
  holdings: [side],
  needs: [{ assetType: other.assetType, assetClass: other.assetClass, quantity: other.quantity, maxUnitValue } satisfies Need],
});

export type AssetScenarioOptions = {
  book: BookClient;
  identities: Record<string, AgentIdentity>;
  /** Akun kontrak lingkaran, penerima NEP-413. */
  contractId: string;
  /** Detik unix. */
  now: () => number;
  pairs?: readonly AssetPair[];
};

/** Satu pasangan: penjual melisting, pembeli menawar, keduanya bernegosiasi sampai bundle yang ditandatangani kedua pihak. */
async function runPair(pair: AssetPair, options: AssetScenarioOptions): Promise<PairOutcome> {
  const make = (name: string, mine: Holding, theirs: Holding, max?: string) =>
    new PolicyAgent({ identity: options.identities[name]!, book: options.book, contractId: options.contractId, policy: policyFor(mine, theirs, max), now: options.now });
  const seller = make(pair.seller, pair.sold, pair.paid);
  const buyer = make(pair.buyer, pair.paid, pair.sold, pair.buyerMaxUnitValue);
  const steps: string[] = [];
  const { hash } = await seller.list();
  steps.push("listed");
  for (let turn = 0; turn < 8; turn += 1) {
    const moves = [...(turn === 0 ? await buyer.shop() : []), ...(await seller.handleInbox()), ...(await buyer.handleInbox())];
    for (const move of moves) steps.push(move.kind);
    if (moves.some((m) => m.kind === "accepted" || m.kind === "rejected")) break;
  }
  // Pihak yang tidak menerima menandatangani bundle.
  await seller.signProposals();
  await buyer.signProposals();
  const proposal = (await options.book.proposals(options.identities[pair.seller]!.accountId, "all")).find((p) => p.listingHash === hash);
  return {
    seller: pair.seller, buyer: pair.buyer, soldType: pair.sold.assetType, soldClass: pair.sold.assetClass,
    paidType: pair.paid.assetType, paidClass: pair.paid.assetClass, listingHash: hash, steps,
    bundle: proposal ? { termsHash: proposal.termsHash, status: proposal.status, participants: proposal.participants.length } : null,
  };
}

/**
 * Aset yang ditolak: kelas `X` (mis. paket langganan konsumen yang melarang pembagian) ditandatangani lalu dikirim langsung ke buku
 * karena `buildListing` sudah menolaknya di sisi agent; server harus menjawab `asset_class_rejected`.
 */
async function tryClassX(options: AssetScenarioOptions, account: string): Promise<RejectedOutcome[]> {
  const identity = options.identities[account]!;
  const listing = {
    circle: options.contractId, account: identity.accountId,
    offer: { asset_type: "plan:streaming-family", asset_class: "X", quantity: 1, value: unit(15) },
    want: { asset_type: "service:translate-calls", asset_class: "D", quantity: 5, value: unit(15) },
    terms: "share the family plan", detail: "consumer plan that forbids sharing", expires_at: options.now() + 3600,
    discount_bps: 0, accept_payment: true, discoverable: true, nonce: "class-x",
  } as unknown as Listing;
  let signature = "ed25519:unsigned";
  try {
    signature = signListing(listing, identity.voucherSecretKey);
  } catch {
    // SDK menolak kelas X saat menandatangani; server tetap diuji dengan tanda tangan kosong
  }
  try {
    await options.book.postListing(listing, signature);
  } catch (error) {
    if (error instanceof BookError) {
      return [{ assetType: listing.offer.asset_type, assetClass: "X", code: error.code, message: error.message, allowed: error.details.allowed }];
    }
    throw error;
  }
  return [];
}

export async function runAssetScenario(options: AssetScenarioOptions): Promise<AssetScenarioReport> {
  const pairs: PairOutcome[] = [];
  for (const pair of options.pairs ?? ASSET_PAIRS) pairs.push(await runPair(pair, options));
  const rejected = await tryClassX(options, "cleaner");
  const classes = [...new Set(pairs.flatMap((p) => [p.soldClass, p.paidClass]))].sort();
  return { pairs, rejected, classes };
}
