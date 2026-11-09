// A-AG-07: an intent is consumed by the bundle that the agent signs for it (no backend needed: the book is a stub).
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, termsHash, type BundleTerms } from "@x207/core";
import { BarterAgent } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";

const C = (n: number) => String(n * 1_000_000);
const CIRCLE = "x207-circle.test.near";
const ME = "me.x207-circle.test.near";
const NOW = 1_800_000_000;
const keys = generateVoucherKeypair();
const identity: AgentIdentity = { accountId: ME, voucherSecretKey: keys.secretKey, voucherPublicKey: keys.publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "50000000" } };
const terms = (other: string, amount: number): BundleTerms => ({
  circle: CIRCLE, epoch: 7,
  legs: [{ payer: ME, payee: other, max_amount: C(amount) }, { payer: other, payee: ME, max_amount: C(amount) }],
});

function agent(proposals: Array<{ termsHash: string; terms: BundleTerms; missing: string[] }> = [], maxBundlePerEpoch?: string, maxBundleLeg?: string) {
  const signed: string[] = [];
  const book = {
    openEpoch: async () => 7,
    proposals: async () => proposals,
    signProposal: async (hash: string) => { signed.push(hash); },
    postIntent: async () => ({}),
  };
  const a = new BarterAgent({ identity, book: book as never, contractId: CIRCLE, now: () => NOW, ...(maxBundlePerEpoch === undefined ? {} : { maxBundlePerEpoch }), ...(maxBundleLeg === undefined ? {} : { maxBundleLeg }) });
  return { a, signed };
}

describe("AG-043 one intent, one signed bundle", () => {
  it("TC-AG-043-01 signTerms: the second proposal for the same need is refused", async () => {
    const { a } = agent();
    await a.postIntent({ service: "a", calls: 1, value: C(10) }, { service: "b", calls: 1, value: C(10) }, 3600);
    expect(a.intents).toHaveLength(1);
    const first = await a.signTerms(terms("x.x207-circle.test.near", 10));
    expect(first).not.toBeNull();
    expect(a.intents).toHaveLength(0);
    expect(await a.signTerms(terms("y.x207-circle.test.near", 10))).toBeNull();
  });

  it("TC-AG-043-02 answerProposals signs one of two proposals that match the same intent", async () => {
    const t1 = terms("x.x207-circle.test.near", 10);
    const t2 = terms("y.x207-circle.test.near", 10);
    const { a, signed } = agent([
      { termsHash: termsHash(t1), terms: t1, missing: [ME] },
      { termsHash: termsHash(t2), terms: t2, missing: [ME] },
    ]);
    await a.postIntent({ service: "a", calls: 1, value: C(10) }, { service: "b", calls: 1, value: C(10) }, 3600);
    const answers = await a.answerProposals();
    expect(answers.map((x) => x.action)).toEqual(["signed", "rejected"]);
    expect(signed).toEqual([termsHash(t1)]);
  });
});

describe("AG-046 the owner's epoch limit also bounds the bundles the agent signs", () => {
  it("TC-AG-046-10 a bundle whose legs of this agent exceed maxPerEpoch is not signed (50 credit): evaluate says over_owner_limit, signTerms returns null", async () => {
    const big = terms("x.x207-circle.test.near", 60); // this agent pays 60 credit, the limit is 50
    const { a } = agent([{ termsHash: termsHash(big), terms: big, missing: [ME] }], C(50));
    await a.postIntent({ service: "a", calls: 1, value: C(60) }, { service: "b", calls: 1, value: C(60) }, 3600);
    expect(await a.evaluate({ termsHash: termsHash(big), terms: big, missing: [ME] } as never)).toEqual({ ok: false, reason: "over_owner_limit" });
    expect(await a.signTerms(big)).toBeNull();
    expect(a.intents).toHaveLength(1); // nothing was consumed
  });

  it("TC-AG-046-11 what was signed counts for the epoch: 30 credit is signed, a second 30 credit in the same epoch is not, the answer of answerProposals is rejected", async () => {
    const t1 = terms("x.x207-circle.test.near", 30);
    const t2 = terms("y.x207-circle.test.near", 30);
    const { a, signed } = agent([{ termsHash: termsHash(t2), terms: t2, missing: [ME] }], C(50));
    await a.postIntent({ service: "a", calls: 1, value: C(30) }, { service: "b", calls: 1, value: C(30) }, 3600);
    await a.postIntent({ service: "a", calls: 1, value: C(30) }, { service: "b", calls: 1, value: C(30) }, 3600);
    expect(await a.signTerms(t1)).not.toBeNull();
    const answers = await a.answerProposals();
    expect(answers).toEqual([{ termsHash: termsHash(t2), action: "rejected", reason: "over_owner_limit" }]);
    expect(signed).toEqual([]);
  });

  it("TC-AG-046-13 maxBundleLeg: a payer leg of 40 credit with a limit of 39.999999 is refused (over_owner_leg_limit); at 40 it is signed; the epoch total is not required", async () => {
    const t = terms("x.x207-circle.test.near", 40);
    const over = agent([{ termsHash: termsHash(t), terms: t, missing: [ME] }], undefined, String(40_000_000 - 1));
    await over.a.postIntent({ service: "a", calls: 1, value: C(40) }, { service: "b", calls: 1, value: C(40) }, 3600);
    expect(await over.a.evaluate({ termsHash: termsHash(t), terms: t, missing: [ME] } as never)).toEqual({ ok: false, reason: "over_owner_leg_limit" });
    expect(await over.a.signTerms(t)).toBeNull();
    expect(over.a.intents).toHaveLength(1);
    const ok = agent([], undefined, C(40));
    await ok.a.postIntent({ service: "a", calls: 1, value: C(40) }, { service: "b", calls: 1, value: C(40) }, 3600);
    expect(await ok.a.signTerms(t)).not.toBeNull();
  });

  it("TC-AG-046-14 two answerProposals at the same time cannot both pass maxBundlePerEpoch (50 credit, 30 each): one signs, one is rejected; a failed signing frees the room", async () => {
    const t1 = terms("x.x207-circle.test.near", 30);
    const signed: string[] = [];
    let fail = false;
    const book = {
      openEpoch: async () => 7,
      proposals: async () => [{ termsHash: termsHash(t1), terms: t1, missing: [ME] }],
      signProposal: async (hash: string) => { await new Promise((r) => setTimeout(r, 10)); if (fail) throw new Error("book down"); signed.push(hash); },
      postIntent: async () => ({}),
    };
    const a = new BarterAgent({ identity, book: book as never, contractId: CIRCLE, now: () => NOW, maxBundlePerEpoch: C(50) });
    for (let i = 0; i < 2; i += 1) await a.postIntent({ service: "a", calls: 1, value: C(30) }, { service: "b", calls: 1, value: C(30) }, 3600);
    // same proposal list in both calls, so the second signing is a different intent but the same epoch budget
    const [r1, r2] = await Promise.all([a.answerProposals(), a.answerProposals()]);
    const actions = [...r1, ...r2].map((x) => x.action).sort();
    expect(actions).toEqual(["rejected", "signed"]);
    expect(signed).toHaveLength(1);
    // a failed signing releases its reservation
    fail = true;
    const b = new BarterAgent({ identity, book: book as never, contractId: CIRCLE, now: () => NOW, maxBundlePerEpoch: C(50) });
    await b.postIntent({ service: "a", calls: 1, value: C(30) }, { service: "b", calls: 1, value: C(30) }, 3600);
    await expect(b.answerProposals()).rejects.toThrow(/book down/);
    fail = false;
    expect((await b.answerProposals()).map((x) => x.action)).toEqual(["signed"]);
  });

  it("TC-AG-046-12 without maxBundlePerEpoch nothing changes: the spend policy of micro payments (maxPerEpoch 50) does not refuse a 60 credit bundle", async () => {
    const big = terms("x.x207-circle.test.near", 60);
    const { a } = agent();
    await a.postIntent({ service: "a", calls: 1, value: C(60) }, { service: "b", calls: 1, value: C(60) }, 3600);
    expect(await a.signTerms(big)).not.toBeNull();
  });
});
