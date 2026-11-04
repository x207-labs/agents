// Waiting listing scenario (AG-017, F9): Andi sells A and seeks B while there is no counterparty yet. The listing stays open across time,
// the counterparty arrives later, both negotiate according to their own policies, and the result is a bundle signed by both parties.
// Another listing never gets a counterparty and disappears from the results after it expires. Time is moved with `advance`.
import { DEFAULT_BARTER_POLICY, PolicyAgent, type BarterPolicy, type StepResult } from "../shared/barter-policy.ts";
import type { BookClient } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";

/** Default unit price 10 credit per unit (listing worth 100 credit); the sandbox test uses a small price so the leg can be paid with a 0.02 call. */
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
      // the late buyer only agrees to pay up to 92% per unit: needs two bargaining rounds
      needs: [{ assetType: "service:translate-calls", assetClass: "D", quantity: 10, maxUnitValue: String(Math.round(unitMicro * 0.92)) }],
    },
  } satisfies Record<string, BarterPolicy>;
}

export const WAITING_POLICIES = waitingPolicies();

export type WaitingEvent = { at: number; what: string };

export type WaitingReport = {
  timeline: WaitingEvent[];
  /** Seconds Andi's listing waits before the first offer. */
  waitedSeconds: number;
  /** Listing with no counterparty that expires and disappears from the `open` results. */
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
  /** Shift the clock of all parties (agents and server) by `seconds`. */
  advance: (seconds: number) => void;
  /** Unit price in credit smallest units; default 10 credit. */
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
  // A second listing with a short lifetime that will not get a counterparty
  const short = new PolicyAgent({ identity: args.seller, book, contractId: args.contractId, policy: { ...policies.seller, listingTtlSeconds: 1800 }, now });
  const { hash: expiredHash } = await short.list();
  note("andi also lists a short-lived offer that nobody will take");

  // Time passes with no counterparty: the listing stays and can be read
  for (const hours of [1, 2]) {
    args.advance(3600);
    const open = (await book.listings({ status: "open" })).map((l) => l.listingHash);
    note(`${hours}h later: listing still open (${open.includes(hash) ? "yes" : "no"}), short offer ${open.includes(expiredHash) ? "still open" : "expired and gone from open results"}`);
  }

  // The counterparty arrives later
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
