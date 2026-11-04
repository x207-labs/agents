// Quick barter scenario (AG-018, F9): Andi, an idle agent, places two listings with a 10% discount from a value of 100. The seeker visits two
// idle agents that opted in: Budi pays at the discounted price (pay path), Citra hands over goods and receives cashback (barter path).
// The example numbers of note F9 are parameters: value 100, discount 1000 bps, seeker share 300 bps. Pay: counterparty 93 = 90 to Andi + 3 to the seeker.
// Barter: Citra hands over goods worth 100 and receives Andi's goods + cashback 7; Andi bears 10; seeker 3.
import { DEFAULT_BARTER_POLICY, PolicyAgent, type BarterPolicy } from "../shared/barter-policy.ts";
import type { BookClient, BundleProposalView } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";
import { SeekerBot, type SeekerPlan, type VisitedAgent } from "../shared/seeker.ts";

const CREDIT = 1_000_000;
const unit = (credits: number): string => String(Math.round(credits * CREDIT));

export const QUICK_PARAMS = { value: 100, discountBps: 1000, searcherShareBps: 300 } as const;

export type QuickParams = { value: number; discountBps: number; searcherShareBps: number };

const andiPolicy = (params: QuickParams, over: Partial<BarterPolicy>): BarterPolicy => ({
  ...DEFAULT_BARTER_POLICY,
  discountBps: params.discountBps,
  discoverable: true,
  ...over,
});

export type QuickReport = {
  plans: Array<{ to: string; mode: "pay" | "barter"; listingValue: string }>;
  pay: { legs: Array<{ from: string; to: string; amount: string }>; counterpartyPays: string; status: string } | null;
  barter: { legs: Array<{ from: string; to: string; amount: string }>; cashback: string; sellerBears: string; status: string } | null;
  seekerRevenue: string;
  /** An agent that did not opt in or was already visited up to the limit gets no referral. */
  skipped: string[];
};

export async function runQuickBarter(args: {
  book: BookClient;
  contractId: string;
  identities: { seller: AgentIdentity; payer: AgentIdentity; barterer: AgentIdentity; seeker: AgentIdentity; bystander: AgentIdentity };
  now: () => number;
  /** Calculation parameters (default from the note F9 example: 100, 1000 bps, 300 bps); value in whole credits. */
  params?: QuickParams;
}): Promise<QuickReport> {
  const { book, identities, contractId, now } = args;
  const params = args.params ?? QUICK_PARAMS;
  const make = (identity: AgentIdentity, policy: BarterPolicy) => new PolicyAgent({ identity, book, contractId, policy, now });
  const value = params.value;
  const payListing = andiPolicy(params, {
    acceptPayment: true,
    holdings: [{ assetType: "service:translate-calls", assetClass: "D", quantity: 10, unitValue: unit(value / 10) }],
    needs: [{ assetType: "service:summarize-calls", assetClass: "D", quantity: 10, maxUnitValue: unit(value / 10) }],
  });
  const barterListing = andiPolicy(params, {
    acceptPayment: false,
    holdings: [{ assetType: "service:translate-batch", assetClass: "D", quantity: 10, unitValue: unit(value / 10) }],
    needs: [{ assetType: "service:scrape-calls", assetClass: "D", quantity: 10, maxUnitValue: unit(value / 10) }],
  });
  const andiPay = make(identities.seller, payListing);
  const andiBarter = make(identities.seller, barterListing);
  await andiPay.list();
  await andiBarter.list();

  // Budi needs a translation service and pays with credit; Citra needs a translation package and hands over the scrape service
  const budi = make(identities.payer, {
    ...DEFAULT_BARTER_POLICY,
    needs: [{ assetType: "service:translate-calls", assetClass: "D", quantity: 10, maxUnitValue: unit(value / 10) }],
  });
  const citra = make(identities.barterer, {
    ...DEFAULT_BARTER_POLICY,
    holdings: [{ assetType: "service:scrape-calls", assetClass: "D", quantity: 10, unitValue: unit(value / 10) }],
    needs: [{ assetType: "service:translate-batch", assetClass: "D", quantity: 10, maxUnitValue: unit(value / 10) }],
  });
  const seeker = make(identities.seeker, DEFAULT_BARTER_POLICY);
  const visited: VisitedAgent[] = [
    { account: identities.payer.accountId, optIn: true, idle: true, canPay: true, offers: [] },
    { account: identities.barterer.accountId, optIn: true, idle: true, canPay: false, offers: [{ assetType: "service:scrape-calls", assetClass: "D", quantity: 10 }] },
    // not opted in: never visited
    { account: identities.bystander.accountId, optIn: false, idle: true, canPay: true, offers: [] },
  ];
  const bot = new SeekerBot({ seeker: identities.seeker.accountId, searcherShareBps: params.searcherShareBps, maxOffersPerAgent: 1, periodSeconds: 3600 });
  const plans: SeekerPlan[] = bot.plan(await book.listings({ status: "open" }), visited, now());

  // The seeker sends a signed referral to the inbox; the target agent bids itself; the lister accepts and the share attaches from the referral
  for (const plan of plans) {
    await seeker.sendReferral(plan, params.searcherShareBps);
    bot.record(plan.to, now());
  }
  const answers = [...(await budi.handleReferrals()), ...(await citra.handleReferrals())];
  if (answers.some((a) => a.action !== "bid")) throw new Error(`referral rejected: ${JSON.stringify(answers)}`);
  await andiPay.handleInbox();
  for (const agent of [andiPay, budi, citra, seeker]) await agent.signProposals();

  const proposals = await book.proposals(identities.seller.accountId, "all");
  const legsOf = (p: BundleProposalView) => p.terms.legs.map((l) => ({ from: l.payer, to: l.payee, amount: l.max_amount }));
  const byMode = (account: string) => proposals.find((p) => p.participants.includes(account));
  const payProposal = byMode(identities.payer.accountId);
  const barterProposal = byMode(identities.barterer.accountId);
  const amount = (p: BundleProposalView | undefined, from: string, to: string) => p?.terms.legs.find((l) => l.payer === from && l.payee === to)?.max_amount ?? "0";
  const fmt = (n: bigint) => n.toString();
  const seekerRevenue = proposals.flatMap((p) => p.terms.legs.filter((l) => l.payee === identities.seeker.accountId)).reduce((n, l) => n + BigInt(l.max_amount), 0n);

  return {
    plans: plans.map((p) => ({ to: p.to, mode: p.mode, listingValue: p.value })),
    pay: payProposal
      ? {
          legs: legsOf(payProposal),
          counterpartyPays: fmt(payProposal.terms.legs.filter((l) => l.payer === identities.payer.accountId).reduce((n, l) => n + BigInt(l.max_amount), 0n)),
          status: payProposal.status,
        }
      : null,
    barter: barterProposal
      ? {
          legs: legsOf(barterProposal),
          cashback: fmt(BigInt(amount(barterProposal, identities.seller.accountId, identities.barterer.accountId)) - BigInt(unit(value))),
          sellerBears: fmt(
            BigInt(amount(barterProposal, identities.seller.accountId, identities.barterer.accountId)) - BigInt(amount(barterProposal, identities.barterer.accountId, identities.seller.accountId)) +
              BigInt(amount(barterProposal, identities.seller.accountId, identities.seeker.accountId)),
          ),
          status: barterProposal.status,
        }
      : null,
    seekerRevenue: fmt(seekerRevenue),
    skipped: visited.filter((v) => !plans.some((p) => p.to === v.account)).map((v) => v.account),
  };
}
