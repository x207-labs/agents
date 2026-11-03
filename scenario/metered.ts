// Skenario `metered` (AG-024, pipeline P5): satu agent menjual dua sumber daya terukur dan agent lain membeli keduanya. Umpan data dijual per panggilan (`call`, satu voucher
// per panggilan, harga dari `createMeteredEndpoint`), job CPU dijual per `job` dan dikerjakan dalam potongan dengan anggaran terkunci sebagai bundle (`JobBudget`, SD-067).
// Tiga job dijalankan: satu selesai, satu diputus pembeli di tengah (pembayaran sama dengan potongan yang selesai), dan satu ditinggal penjual di tengah potongan (pembeli
// rugi satu potongan, yang sudah dibayar di muka). Hanya voucher dan bundle yang sudah ada; tidak ada kontrak baru dan tidak ada jaringan.
import { signVoucher, verifyVoucher, voucherPublicKey, type BundleTerms, type Voucher, type VoucherSecretKey } from "@x207/core";
import { BuyerJob, JobBudget, SellerJob, createMeteredEndpoint, resolvePrice } from "@x207/scheme";

export const FEED_CALLS = 10;
export const JOB_CHUNKS = 4;

export type MeteredJobReport = {
  jobId: string;
  /** Siapa yang berhenti: tidak ada, pembeli berhenti membayar, atau penjual hilang di tengah potongan. */
  stoppedBy: "none" | "buyer" | "seller";
  completedChunks: number;
  /** Yang dibayar untuk job ini (potongan yang selesai ditambah potongan yang dibayar di muka dan tidak selesai). */
  paid: string;
  /** Harga potongan yang selesai. */
  earned: string;
  /** Yang hilang dari pembeli: potongan yang dibayar dan tidak dikerjakan. */
  buyerLoss: string;
  /** Yang dikerjakan penjual tanpa dibayar. */
  sellerUnpaidWork: string;
  bundle: BundleTerms;
};

export type MeteredOutcome = {
  feed: { calls: number; paid: string; unit: string; unitPrice: string };
  jobs: MeteredJobReport[];
  /** Semua voucher yang ditandatangani pembeli, urut; satu rangkaian kumulatif untuk pasangan (pembeli, penjual). */
  vouchers: Voucher[];
  /** Voucher terakhir: yang didaftarkan untuk pasangan ini. */
  cumulative: string;
  seq: number;
};

export async function runMeteredScenario(args: { circle: string; epoch: number; buyer: string; seller: string; buyerKey: VoucherSecretKey }): Promise<MeteredOutcome> {
  const { circle, epoch, buyer, seller, buyerKey } = args;
  const vouchers: Voucher[] = [];
  let cumulative = 0n;
  let seq = 0;

  // 1. umpan data per panggilan: tiap panggilan satu voucher untuk jumlah yang diumumkan penjual
  const feed = createMeteredEndpoint({ kind: "data-feed", unitPrice: "$0.002", handler: () => new Response("price: 42") });
  for (let call = 1; call <= FEED_CALLS; call++) {
    const { amount } = await resolvePrice(feed.route.price, new Request("https://compute.example/api/feed?quantity=1"), feed.route.maxQuantity);
    cumulative += BigInt(amount);
    seq += 1;
    vouchers.push(signVoucher({ circle, payer: buyer, payee: seller, epoch, seq, cumulativeAmount: cumulative.toString(), unit: "credit", resource: `feed:${feed.assetType}` }, buyerKey));
  }
  const feedPaid = cumulative;

  // 2. tiga job CPU, masing-masing dengan anggaran (bundle) sendiri, melanjutkan voucher pasangan
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

/** Voucher yang sah menurut kunci pembeli, dan rangkaian kumulatif yang naik tanpa lubang. */
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
