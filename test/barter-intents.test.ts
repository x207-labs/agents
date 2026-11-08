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

function agent(proposals: Array<{ termsHash: string; terms: BundleTerms; missing: string[] }> = []) {
  const signed: string[] = [];
  const book = {
    openEpoch: async () => 7,
    proposals: async () => proposals,
    signProposal: async (hash: string) => { signed.push(hash); },
    postIntent: async () => ({}),
  };
  const a = new BarterAgent({ identity, book: book as never, contractId: CIRCLE, now: () => NOW });
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
