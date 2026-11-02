import { afterEach, describe, expect, it } from "vitest";
import { runWaitingScenario } from "../scenario/waiting.ts";
import { acct, BACKEND_AVAILABLE, CONTRACT, startMarketBook, type MarketBook } from "./market.ts";

const START = Date.parse("2026-11-04T10:00:00Z");

describe.skipIf(!BACKEND_AVAILABLE)("AG-017 listing menunggu lintas waktu", () => {
  let market: MarketBook | undefined;
  afterEach(async () => market?.stop());

  it("TC-AG-017-01 listing menunggu dua jam tanpa lawan, lawan datang, negosiasi, lalu bundle ready", async () => {
    market = await startMarketBook(["translator", "summarizer"], { now: START });
    const m = market;
    const clock = { now: Math.floor(START / 1000) };
    const advance = (seconds: number) => {
      clock.now += seconds;
      m.clock.now = clock.now * 1000;
    };
    const report = await runWaitingScenario({ book: m.book, seller: m.identities.translator!, late: m.identities.summarizer!, contractId: CONTRACT, clock, advance });

    // menunggu: dua jam penuh sebelum tawaran pertama
    expect(report.waitedSeconds).toBe(7200);
    // listing pendek hilang dari hasil open setelah kedaluwarsa, listing utama masih terbuka sampai dicocokkan
    expect(report.timeline.some((t) => t.what.includes("1h later: listing still open (yes), short offer still open") || t.what.includes("1h later: listing still open (yes), short offer expired"))).toBe(true);
    expect(report.timeline.find((t) => t.what.startsWith("2h later"))?.what).toContain("short offer expired and gone from open results");
    const open = await m.book.listings({ status: "open" });
    expect(open.some((l) => l.listingHash === report.expiredHash)).toBe(false);
    expect((await m.book.listings({ status: "expired" })).some((l) => l.listingHash === report.expiredHash)).toBe(true);

    // negosiasi dua putaran lalu diterima, listing menjadi matched, bundle ditandatangani kedua pihak
    expect(report.rounds.map((r) => r.kind)).toEqual(["bid", "countered", "countered", "accepted"]);
    expect(report.bundle).toMatchObject({ status: "ready", participants: 2 });
    expect((await m.book.listings({ status: "matched" })).map((l) => l.account)).toEqual([acct("translator")]);
    // waktu tawar-menawar tercatat berurutan
    const times = report.timeline.map((t) => t.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
