import { afterEach, describe, expect, it } from "vitest";
import { runWaitingScenario } from "../scenario/waiting.ts";
import { acct, BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const START = Date.parse("2026-11-04T10:00:00Z");

describe.skipIf(!BACKEND_AVAILABLE)("AG-017 a listing waits across time", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-017-01 a listing waits two hours without a counterparty, the counterparty arrives, negotiation, then bundle ready", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: START });
    const m = market;
    const clock = { now: Math.floor(START / 1000) };
    const advance = (seconds: number) => {
      clock.now += seconds;
      m.clock.now = clock.now * 1000;
    };
    const report = await runWaitingScenario({ book: m.book, seller: m.identities.translator!, late: m.identities.summarizer!, contractId: CONTRACT, clock, advance });

    // waiting: two full hours before the first offer
    expect(report.waitedSeconds).toBe(7200);
    // the short listing disappears from the open results after it expires, the main listing stays open until matched
    expect(report.timeline.some((t) => t.what.includes("1h later: listing still open (yes), short offer still open") || t.what.includes("1h later: listing still open (yes), short offer expired"))).toBe(true);
    expect(report.timeline.find((t) => t.what.startsWith("2h later"))?.what).toContain("short offer expired and gone from open results");
    const open = await m.book.listings({ status: "open" });
    expect(open.some((l) => l.listingHash === report.expiredHash)).toBe(false);
    expect((await m.book.listings({ status: "expired" })).some((l) => l.listingHash === report.expiredHash)).toBe(true);

    // negotiation of two rounds then accepted, the listing becomes matched, the bundle is signed by both parties
    expect(report.rounds.map((r) => r.kind)).toEqual(["bid", "countered", "countered", "accepted"]);
    expect(report.bundle).toMatchObject({ status: "ready", participants: 2 });
    expect((await m.book.listings({ status: "matched" })).map((l) => l.account)).toEqual([acct("translator")]);
    // the bargaining times are recorded in order
    const times = report.timeline.map((t) => t.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
