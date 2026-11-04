// `metered` scenario (AG-024, pipeline P5): one agent sells two metered resources and another agent buys both. The data feed is sold per call (`call`, one voucher
// per call, price from `createMeteredEndpoint`), the CPU job is sold per `job` and done in chunks with a locked budget as a bundle (`JobBudget`, SD-067).
// Three jobs run: one completes, one is cut off by the buyer midway (payment equals the completed chunks), and one is abandoned by the seller mid-chunk (the buyer
// loses one chunk, which was prepaid). Only the existing vouchers and bundles; no new contract and no network.
import { signVoucher, verifyVoucher, voucherPublicKey, type BundleTerms, type Voucher, type VoucherSecretKey } from "@x207/core";
import { BuyerJob, JobBudget, SellerJob, createMeteredEndpoint, resolvePrice } from "@x207/scheme";

export const FEED_CALLS = 10;
export const JOB_CHUNKS = 4;

export type MeteredJobReport = {
  jobId: string;
  /** Who stopped: nobody, the buyer stopped paying, or the seller vanished mid-chunk. */
  stoppedBy: "none" | "buyer" | "seller";
  completedChunks: number;
  /** What was paid for this job (completed chunks plus the prepaid chunk that was not completed). */
  paid: string;
  /** Price of the completed chunks. */
  earned: string;
  /** What the buyer lost: chunks that were paid for and not worked. */
  buyerLoss: string;
  /** What the seller worked without being paid. */
  sellerUnpaidWork: string;
  bundle: BundleTerms;
};

export type MeteredOutcome = {
  feed: { calls: number; paid: string; unit: string; unitPrice: string };
  jobs: MeteredJobReport[];
  /** All vouchers signed by the buyer, in order; one cumulative series for the (buyer, seller) pair. */
  vouchers: Voucher[];
  /** The last voucher: the one registered for this pair. */
  cumulative: string;
  seq: number;
};

export async function runMeteredScenario(args: { circle: string; epoch: number; buyer: string; seller: string; buyerKey: VoucherSecretKey }): Promise<MeteredOutcome> {
  const { circle, epoch, buyer, seller, buyerKey } = args;
  const vouchers: Voucher[] = [];
  let cumulative = 0n;
  let seq = 0;

  // 1. data feed per call: each call one voucher for the amount the seller announces
  const feed = createMeteredEndpoint({ kind: "data-feed", unitPrice: "$0.002", handler: () => new Response("price: 42") });
  for (let call = 1; call <= FEED_CALLS; call++) {
    const { amount } = await resolvePrice(feed.route.price, new Request("https://compute.example/api/feed?quantity=1"), feed.route.maxQuantity);
    cumulative += BigInt(amount);
    seq += 1;
    vouchers.push(signVoucher({ circle, payer: buyer, payee: seller, epoch, seq, cumulativeAmount: cumulative.toString(), unit: "credit", resource: `feed:${feed.assetType}` }, buyerKey));
  }
  const feedPaid = cumulative;

  // 2. three CPU jobs, each with its own budget (bundle), continuing the pair's vouchers
  const cpu = createMeteredEndpoint({ kind: "cpu", unit: "job", unitPrice: "$4", handler: () => new Response("done") });
  const jobs: MeteredJobReport[] = [];
  const runJob = (jobId: string, stoppedBy: MeteredJobReport["stoppedBy"], limit: number): void => {
    const budget = new JobBudget({
      jobId, unit: "job", chunkQuantity: "0.25", unitPrice: "$4", chunks: JOB_CHUNKS, circle, buyer, seller, epoch, baseCumulative: cumulative.toString(), baseSeq: seq,
    });
    const buyerSide = new BuyerJob(budget);
    const sellerSide = new SellerJob(budget);
    for (let guard = 0; guard < 100; guard++) {
      const pay = buyerSide.nextChunk();
      if (pay !== null && !(stoppedBy === "buyer" && pay > limit)) {
        const signed = buyerSide.signNext(buyerKey);
        vouchers.push(signed.voucher);
        sellerSide.accept(signed.voucher);
      }
      const chunk = sellerSide.next();
      if (chunk === null) break;
      sellerSide.start();
      if (stoppedBy === "seller" && chunk > limit) break; // the seller disappears inside this chunk
      sellerSide.complete(chunk);
      buyerSide.confirm(chunk);
    }
    const s = sellerSide.summary();
    const b = buyerSide.summary();
    cumulative = budget.baseCumulative + BigInt(b.cumulativeSigned);
    seq = budget.baseSeq + b.signedChunks;
    jobs.push({
      jobId, stoppedBy, completedChunks: s.completedChunks, paid: b.cumulativeSigned, earned: (budget.chunkAmount * BigInt(s.completedChunks)).toString(),
      buyerLoss: b.atRisk, sellerUnpaidWork: s.unpaidWork, bundle: budget.terms(),
    });
  };
  runJob("render-1", "none", JOB_CHUNKS);
  runJob("render-2", "buyer", 2);
  runJob("render-3", "seller", 2);

  return {
    feed: { calls: FEED_CALLS, paid: feedPaid.toString(), unit: feed.unit, unitPrice: feed.unitPriceAtomic },
    jobs, vouchers, cumulative: cumulative.toString(), seq,
  };
}

/** Vouchers valid under the buyer key, and a cumulative series that rises with no gaps. */
export function verifyOutcome(outcome: MeteredOutcome, buyer: string, buyerKey: VoucherSecretKey): boolean {
  const publicKey = voucherPublicKey(buyerKey);
  let last = 0n;
  let seq = 0;
  for (const v of outcome.vouchers) {
    if (v.payer !== buyer || !verifyVoucher(v, publicKey) || v.seq !== seq + 1 || BigInt(v.cumulativeAmount) <= last) return false;
    last = BigInt(v.cumulativeAmount);
    seq = v.seq;
  }
  return last.toString() === outcome.cumulative && seq === outcome.seq;
}
