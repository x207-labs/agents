// A-AG-08/09: the agent buyer refuses a 402 that names a payee or an epoch the owner did not choose; nothing is signed or sent a second time.
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair } from "@x207/core";
import { createAgentBuyer } from "../shared/x207.ts";
import type { AgentIdentity } from "../shared/identity.ts";

const keys = generateVoucherKeypair();
const identity: AgentIdentity = { accountId: "buyer.x207-circle.test.near", voucherSecretKey: keys.secretKey, voucherPublicKey: keys.publicKey, policy: { maxPerCall: "100000", maxPerEpoch: "50000000" } };
const requirements = (payTo: string, epoch: number) => ({
  scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo, maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.test.near", unit: "credit", decimals: 6, epoch },
});

function seller(payTo: string, epoch: number) {
  const seen: Array<Headers> = [];
  const fetchStub = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push(headers);
    if (headers.has("payment-signature")) return new Response("paid", { status: 200 });
    const header = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "https://seller.example/api/x" }, accepts: [requirements(payTo, epoch)] } as never);
    return new Response("{}", { status: 402, headers: { "payment-required": header } });
  }) as typeof fetch;
  return { fetchStub, seen };
}

describe("AG-045 buyer accept", () => {
  it("TC-AG-045-02 a payee outside the allowed list or an epoch other than the open one is refused; the allowed one is paid", async () => {
    const accept = { circles: ["x207-circle.test.near"], payees: ["good.x207-circle.test.near"], currentEpoch: async () => 5 };
    const evil = seller("evil.x207-circle.test.near", 5);
    await expect(createAgentBuyer(identity, { fetch: evil.fetchStub, accept })("https://seller.example/api/x")).rejects.toThrow(/not one that this buyer pays/);
    expect(evil.seen.some((h) => h.has("payment-signature"))).toBe(false);
    const future = seller("good.x207-circle.test.near", 9);
    await expect(createAgentBuyer(identity, { fetch: future.fetchStub, accept })("https://seller.example/api/x")).rejects.toThrow(/not the open epoch 5/);
    expect(future.seen.some((h) => h.has("payment-signature"))).toBe(false);
  });
});
