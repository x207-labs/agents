// Skenario listing menunggu (AG-017, F9): Andi menjual A dan mencari B saat belum ada lawan. Listing tetap terbuka lintas waktu,
// lawan datang kemudian, keduanya bernegosiasi menurut kebijakan masing-masing, dan hasilnya bundle yang ditandatangani kedua pihak.
// Satu listing lain tidak pernah mendapat lawan dan hilang dari hasil setelah kedaluwarsa. Waktu digerakkan lewat `advance`.
import { DEFAULT_BARTER_POLICY, PolicyAgent, type BarterPolicy, type StepResult } from "../shared/barter-policy.ts";
import type { BookClient } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";

/** Harga satuan default 10 credit per unit (listing bernilai 100 credit); test sandbox memakai harga kecil agar leg bisa dibayar dengan panggilan 0,02. */
export const DEFAULT_UNIT_MICRO = 10_000_000;

export function waitingPolicies(unitMicro: number = DEFAULT_UNIT_MICRO) {
  return {
    seller: {
      ...DEFAULT_BARTER_POLICY,
      holdings: [{ assetType: "service:translate-calls", assetClass: "D", quantity: 10, unitValue: String(unitMicro) }],
      needs: [{ assetType: "service:summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: String(unitMicro) }],
      listingTtlSeconds: 6 * 3600,
    },
    late: {
      ...DEFAULT_BARTER_POLICY,
      holdings: [{ assetType: "service:summarize-calls", assetClass: "D", quantity: 10, unitValue: String(unitMicro) }],
      // pembeli terlambat hanya mau membayar sampai 92% per unit: perlu dua putaran tawar
      needs: [{ assetType: "service:translate-calls", assetClass: "D", quantity: 10, maxUnitValue: String(Math.round(unitMicro * 0.92)) }],
    },
  } satisfies Record<string, BarterPolicy>;
}

export const WAITING_POLICIES = waitingPolicies();

export type WaitingEvent = { at: number; what: string };

export type WaitingReport = {
  timeline: WaitingEvent[];
  /** Detik listing Andi menunggu sebelum ada tawaran pertama. */
  waitedSeconds: number;
  /** Listing tanpa lawan yang kedaluwarsa dan hilang dari hasil `open`. */
  expiredHash: string;
  rounds: Array<{ kind: StepResult["kind"]; value?: string }>;
  bundle: { termsHash: string; status: string; participants: number } | null;
};

export async function runWaitingScenario(args: {
  book: BookClient;
  seller: AgentIdentity;
  late: AgentIdentity;
  contractId: string;
  clock: { now: number };
  /** Geser jam semua pihak (agent dan server) sebesar `seconds`. */
  advance: (seconds: number) => void;
  /** Harga satuan dalam satuan terkecil credit; default 10 credit. */
  unitMicro?: number;
}): Promise<WaitingReport> {
  const { book, clock } = args;
  const now = () => clock.now;
  const timeline: WaitingEvent[] = [];
  const note = (what: string) => timeline.push({ at: clock.now, what });
  const make = (identity: AgentIdentity, policy: BarterPolicy) => new PolicyAgent({ identity, book, contractId: args.contractId, policy, now });
  const policies = waitingPolicies(args.unitMicro);
  const andi = make(args.seller, policies.seller);
  const budi = make(args.late, policies.late);

  const listedAt = clock.now;
  const { hash } = await andi.list();
  note("andi lists translate-calls, wants summarize-calls; no counterparty exists yet");
  // Listing kedua dengan umur pendek yang tidak akan mendapat lawan
  const short = new PolicyAgent({ identity: args.seller, book, contractId: args.contractId, policy: { ...policies.seller, listingTtlSeconds: 1800 }, now });
  const { hash: expiredHash } = await short.list();
  note("andi also lists a short-lived offer that nobody will take");

  // Waktu berjalan tanpa lawan: listing tetap ada dan terbaca
  for (const hours of [1, 2]) {
    args.advance(3600);
    const open = (await book.listings({ status: "open" })).map((l) => l.listingHash);
    note(`${hours}h later: listing still open (${open.includes(hash) ? "yes" : "no"}), short offer ${open.includes(expiredHash) ? "still open" : "expired and gone from open results"}`);
  }

  // Lawan datang kemudian
  const arrival = clock.now;
  const bids = await budi.shop();
  note(`budi arrives, finds the listing and bids ${bids[0]?.kind === "bid" ? bids[0].value : "nothing"}`);
  const rounds: WaitingReport["rounds"] = bids.map((b) => ({ kind: b.kind, ...(b.kind === "bid" ? { value: b.value } : {}) }));

  for (let turn = 0; turn < 6; turn += 1) {
    args.advance(60);
    const moves = [...(await andi.handleInbox()), ...(await budi.handleInbox())];
    for (const m of moves) {
      rounds.push({ kind: m.kind, ...(m.kind === "countered" ? { value: m.value } : {}) });
      note(`${m.kind}${m.kind === "countered" ? ` at ${m.value}` : ""}`);
    }
    if (moves.some((m) => m.kind === "accepted" || m.kind === "rejected")) break;
  }
  await andi.signProposals();
  await budi.signProposals();
  const proposal = (await book.proposals(args.seller.accountId, "all")).find((p) => p.listingHash === hash);
  note(proposal ? `bundle ${proposal.status}` : "no bundle");
  return {
    timeline,
    waitedSeconds: arrival - listedAt,
    expiredHash,
    rounds,
    bundle: proposal ? { termsHash: proposal.termsHash, status: proposal.status, participants: proposal.participants.length } : null,
  };
}
