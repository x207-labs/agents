import { describe, expect, it } from "vitest";
import { generateVoucherKeypair } from "@x207/core";
import { FEED_CALLS, JOB_CHUNKS, runMeteredScenario, verifyOutcome } from "../scenario/metered.ts";

const CIRCLE = "x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const SELLER = "compute.x207-circle.near";
const key = generateVoucherKeypair();
const run = () => runMeteredScenario({ circle: CIRCLE, epoch: 42, buyer: BUYER, seller: SELLER, buyerKey: key.secretKey });

describe("AG-024 metered resources: a CPU job in chunks and a data feed per call, one job cut in the middle", () => {
  it("TC-AG-024-01 the feed is paid per call at the unit price of the endpoint, one voucher per call", async () => {
    const o = await run();
    expect(o.feed).toEqual({ calls: FEED_CALLS, paid: "20000", unit: "call", unitPrice: "2000" });
    expect(o.vouchers.slice(0, FEED_CALLS).map((v) => v.cumulativeAmount)).toEqual(Array.from({ length: FEED_CALLS }, (_, i) => String((i + 1) * 2000)));
  });

  it("TC-AG-024-02 a job that runs to the end pays all chunks; a job the buyer stops pays exactly the chunks that were done; the seller never works unpaid", async () => {
    const [full, cutByBuyer] = (await run()).jobs;
    expect(full).toMatchObject({ stoppedBy: "none", completedChunks: JOB_CHUNKS, paid: "4000000", earned: "4000000", buyerLoss: "0", sellerUnpaidWork: "0" });
    expect(cutByBuyer).toMatchObject({ stoppedBy: "buyer", completedChunks: 2, paid: "2000000", earned: "2000000", buyerLoss: "0", sellerUnpaidWork: "0" });
  });

  it("TC-AG-024-03 a seller that disappears inside a chunk costs the buyer that one chunk and no more", async () => {
    const lost = (await run()).jobs[2]!;
    expect(lost).toMatchObject({ stoppedBy: "seller", completedChunks: 2, earned: "2000000", paid: "3000000", buyerLoss: "1000000", sellerUnpaidWork: "0" });
  });

  it("TC-AG-024-04 one cumulative series for the pair: signed by the buyer, seq without gaps, the total is the feed plus the jobs, and each job has its bundle of two legs", async () => {
    const o = await run();
    expect(verifyOutcome(o, BUYER, key.secretKey)).toBe(true);
    expect(o.cumulative).toBe(String(20_000 + 4_000_000 + 2_000_000 + 3_000_000));
    expect(o.seq).toBe(FEED_CALLS + 4 + 2 + 3);
    for (const job of o.jobs) {
      expect(job.bundle.legs).toEqual([
        { payer: BUYER, payee: SELLER, max_amount: "4000000" },
        { payer: SELLER, payee: BUYER, max_amount: "1" },
      ]);
    }
    // a voucher altered after signing no longer verifies
    expect(verifyOutcome({ ...o, vouchers: o.vouchers.map((v, i) => (i === 3 ? { ...v, cumulativeAmount: "1" } : v)) }, BUYER, key.secretKey)).toBe(false);
  });
});
