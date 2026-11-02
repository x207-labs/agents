import { describe, expect, it } from "vitest";
import { CALL_PRICE, CALLS_PER_LEG, LEG_AMOUNT, legPayments, payLegs, ringIntents, RING_MEMBERS } from "../scenario/ring.ts";

describe("AG-013 cincin barter A, B, C", () => {
  it("intent seimbang: tiap anggota butuh persis yang ditawarkan anggota berikutnya dan nilainya sama dengan leg", () => {
    const intents = ringIntents();
    expect(intents.map((i) => i.agent)).toEqual([...RING_MEMBERS]);
    intents.forEach((intent, i) => {
      const next = intents[(i + 1) % intents.length]!;
      expect(intent.need).toEqual(next.offer);
      expect(Number(intent.offer.value)).toBe(LEG_AMOUNT);
    });
    expect(LEG_AMOUNT).toBe(CALL_PRICE * CALLS_PER_LEG);
  });

  it("pembayaran leg: tiap pembeli membayar penyedia berikutnya dan kumulatif tepat sebesar leg", async () => {
    const calls: string[] = [];
    const cumulative = await payLegs(async (buyer, seller) => (calls.push(`${buyer}>${seller}`), new Response("{}", { status: 200 })));
    expect(legPayments()).toHaveLength(3);
    expect(calls).toHaveLength(3 * CALLS_PER_LEG);
    expect(Object.values(cumulative)).toEqual([BigInt(LEG_AMOUNT), BigInt(LEG_AMOUNT), BigInt(LEG_AMOUNT)]);
    expect(Object.keys(cumulative)).toEqual(["translator>summarizer", "summarizer>scraper", "scraper>translator"]);
  });

  it("pembayaran yang gagal menghentikan skenario dengan pesan jelas", async () => {
    await expect(payLegs(async () => new Response("no", { status: 402 }))).rejects.toThrow(/translator -> summarizer: HTTP 402/);
  });
});
