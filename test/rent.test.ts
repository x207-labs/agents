// AG-028: an agent that rents accesses by the day (SD-071, ADR-47) against the real access broker (BE-057, BE-060), in process: the broker handler is the server, the chain and the
// facilitator are in memory, the providers are the SSH adapter (an in-memory `authorized_keys`, checked by what sshd does with it) and mocks (a repository collaborator, a cloud role with a
// real cost per day). The paying side is the SDK (`DailyRent`): one day in advance, the next day only if the access still works, the real cost only up to the cap, nothing after a stop.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RentError as SdkRentError, generateVoucherKeypair, signSshChallenge, sshEd25519Line, encodeGranteeProof, granteeChallenge, verifyVoucher } from "@x207/core";
import { RentLessee } from "../scenario/rent.ts";
import { BROKER_AVAILABLE, CIRCLE, DAY, GRANTEE, GRANTOR, START, startBroker } from "./broker-fixtures.ts";

const credit = (n: number): string => (BigInt(Math.round(n * 1_000_000))).toString();
const PRICE = "250000";
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

describe.skipIf(!BROKER_AVAILABLE)("AG-028 daily rent of an access: SSH, a repository, an early revoke, a lessee that stops, a cloud role billed by real cost", () => {
  const keys = generateVoucherKeypair();
  const lessee = (rig: Awaited<ReturnType<typeof startBroker>>, grantId: number, granteeRef: string, dailyCap?: string) =>
    new RentLessee("http://broker.test", rig.brokerFetch, { circle: CIRCLE, payer: GRANTEE, payee: GRANTOR, grantId, dailyPrice: PRICE, ...(dailyCap ? { dailyCap } : {}), secretKey: keys.secretKey, now: () => rig.chain.now, granteeRef });
  /** The pair as the contract would hold it: the test plays the contract by adding what the lessee signed. */
  const ledger = () => {
    let seq = 0;
    let cumulative = 0n;
    return {
      state: () => ({ seq, cumulativeAmount: cumulative.toString() }),
      take: (v: { seq: number; cumulativeAmount: string }) => {
        expect(v.seq).toBe(seq + 1);
        seq = v.seq;
        cumulative = BigInt(v.cumulativeAmount);
      },
    };
  };
  const setup = async (more: (b: any) => any[] = () => []) => {
    const files = { text: "" };
    const rig = await startBroker((b, { now }) => [
      new b.SshAdapter({ file: { read: async () => files.text, write: async (t: string) => void (files.text = t) }, now }),
      new b.MockProviderAdapter({ provider: "github", now }),
      ...more(b),
    ]);
    rig.registerVoucherKey(GRANTEE, keys.publicKey);
    return { rig, files };
  };

  it("TC-AG-028-01 an SSH key is rented: the owner of the key proves it with a signature, the key is in authorized_keys until the end of the paid day, and the next day is paid only while it works", async () => {
    const { rig, files } = await setup();
    const seed = new Uint8Array(32).fill(7);
    // the public key of the SSH key: node derives it from the seed (PKCS#8 wrapper of an ed25519 seed)
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
    const pub = Buffer.from(createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x!, "base64url");
    const ref = sshEd25519Line(new Uint8Array(pub), "lessee");
    rig.grant(1, { provider: "ssh", grantee_ref: ref, resource: "/usr/local/bin/run-job" });
    const agent = lessee(rig, 1, ref);
    const book = ledger();

    // the challenge binds circle, grant, reference and a nonce of the broker; the proof is the signature of the private key of the reference
    const ch = await agent.challenge();
    expect(ch).not.toBeNull();
    expect(ch!.challenge).toBe(granteeChallenge({ circle: CIRCLE, grantId: 1, granteeRef: ref, nonce: ch!.nonce }));
    const proof = encodeGranteeProof(signSshChallenge({ circle: CIRCLE, grantId: 1, granteeRef: ref, nonce: ch!.nonce }, seed));
    const day1 = await agent.payDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state(), proof });
    book.take(day1.voucher);
    expect(verifyVoucher(day1.voucher, keys.publicKey)).toBe(true);
    expect(day1.voucher).toMatchObject({ resource: "x207:grant:1", cumulativeAmount: PRICE });
    expect(day1.view).toMatchObject({ status: "active", proof: "verified", provider: "ssh" });
    // what sshd does: the key gets in now, with the forced command, and not after the paid day
    expect(rig.b.sshdAccepts(files.text, ref, rig.chain.now)).toMatchObject({ accepted: true });
    expect(rig.b.sshdAccepts(files.text, ref, rig.chain.now)!.options).toContain('command="/usr/local/bin/run-job"');
    expect(rig.b.sshdAccepts(files.text, ref, day1.view.paidUntil + 2_000).accepted).toBe(false); // the provider closes it by itself, even if the broker is down

    // the next day: the broker says active, so the agent signs and pays; the end of the paid day moves one day
    rig.chain.now += DAY - 3_600_000;
    const day2 = await agent.payNextDay({ day: dayOf(rig.chain.now + 3_600_000), epoch: 42, state: book.state() });
    book.take(day2.voucher);
    expect(day2.voucher.cumulativeAmount).toBe(credit(0.5));
    expect(day2.view.paidUntil).toBe(day1.view.paidUntil + DAY);
    expect(agent.daily.daysPaid).toBe(2);
  });

  it("TC-AG-028-02 a repository collaborator (mock) is rented and the lessee stops: the access is gone at the provider, and the SDK signs no voucher after the stop", async () => {
    const { rig } = await setup();
    rig.grant(2, { provider: "github", grantee_ref: "alice-dev", resource: "x207-labs/contracts", permission: "pull" });
    const agent = lessee(rig, 2, "alice-dev");
    const book = ledger();
    const first = await agent.payDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state() });
    book.take(first.voucher);
    expect(first.view).toMatchObject({ status: "active", provider: "github", granteeRef: "alice-dev" });
    expect(first.view.delivery).toMatchObject({ account: "alice-dev", resource: "x207-labs/contracts" });
    const github = rig.adapters.find((a: any) => a.provider === "github");
    expect([...github.entries.values()].map((e: any) => e.removed)).toEqual([false]);

    const stopped = await agent.stop(Math.floor(rig.chain.now / 1000));
    expect(stopped.status).toBe("revoked");
    expect([...github.entries.values()].map((e: any) => e.removed)).toEqual([true]);
    await expect(agent.payNextDay({ day: dayOf(rig.chain.now + DAY), epoch: 42, state: book.state() })).rejects.toMatchObject({ code: "rent_stopped" });
    expect(agent.daily.daysPaid).toBe(1);
    expect(book.state().cumulativeAmount).toBe(PRICE); // one day paid, nothing after the stop
  });

  it("TC-AG-028-03 the grantor revokes early: the broker says revoked, the SDK does not sign the next day, and the loss of the lessee is the one day it paid", async () => {
    const { rig } = await setup();
    rig.grant(3, { provider: "github", grantee_ref: "alice-dev", resource: "x207-labs/sdk", permission: "pull" });
    const agent = lessee(rig, 3, "alice-dev");
    const book = ledger();
    book.take((await agent.payDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state() })).voucher);
    // the grantor takes the access away before the day is over
    await rig.manager.revokeAccess(3, "grantor_revoked");
    rig.chain.now += DAY - 3_600_000;
    const error = await agent.payNextDay({ day: dayOf(rig.chain.now + 3_600_000), epoch: 42, state: book.state() }).catch((e) => e);
    expect(error).toBeInstanceOf(SdkRentError);
    expect(error.code).toBe("rent_access_not_active");
    expect(agent.daily.daysPaid).toBe(1);
    expect(book.state().cumulativeAmount).toBe(PRICE);
    // and a direct check against the provider also refuses an access the broker still calls active
    const { rig: rig2 } = await setup();
    rig2.grant(4, { provider: "github", grantee_ref: "alice-dev", resource: "x207-labs/sdk", permission: "pull" });
    const agent2 = lessee(rig2, 4, "alice-dev");
    const book2 = ledger();
    book2.take((await agent2.payDay({ day: dayOf(rig2.chain.now), epoch: 42, state: book2.state() })).voucher);
    rig2.chain.now += DAY - 3_600_000;
    const direct = await agent2.payNextDay({ day: dayOf(rig2.chain.now + 3_600_000), epoch: 42, state: book2.state(), directCheck: async () => false }).catch((e) => e);
    expect(direct.code).toBe("rent_direct_check_failed");
    expect(agent2.daily.daysPaid).toBe(1);
  });

  it("TC-AG-028-04 the lessee stops paying: the paid day ends, the broker closes the access by itself at the provider, and nothing more is owed", async () => {
    const { rig, files } = await setup();
    rig.grant(5, { provider: "github", grantee_ref: "bob-dev", resource: "x207-labs/agents", permission: "pull" });
    const agent = lessee(rig, 5, "bob-dev");
    const book = ledger();
    const first = await agent.payDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state() });
    book.take(first.voucher);
    // no second payment: the day passes and the sweep of the broker closes the access
    rig.chain.now = first.view.paidUntil + 1_000;
    const swept = await rig.manager.sweep();
    expect(swept.map((a: any) => [a.grantId, a.status])).toEqual([[5, "revoked"]]);
    const view = await agent.view();
    expect(view.status).toBe("revoked");
    const error = await agent.payNextDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state() }).catch((e) => e);
    expect(error.code).toBe("rent_access_not_active");
    expect(book.state().cumulativeAmount).toBe(PRICE);
    void files;
  });

  it("TC-AG-028-05 a cloud role is billed by its real cost per day: a bill under the daily cap is signed as a second voucher, a bill over the cap is not and the access is closed", async () => {
    let cost = 1_200_000n;
    const { rig } = await setup((b) => [new b.MockProviderAdapter({ provider: "aws-sts", now: () => rig0.now(), costPerDay: () => cost })]);
    const rig0 = { now: () => rig.chain.now };
    rig.grant(6, { provider: "aws-sts", grantee_ref: "ci-runner", resource: "arn:aws:iam::123456789012:role/x207-viewer", permission: "viewer", daily_cap: "2000000" });
    const agent = lessee(rig, 6, "ci-runner", "2000000");
    const book = ledger();
    const first = await agent.payDay({ day: dayOf(rig.chain.now), epoch: 42, state: book.state() });
    book.take(first.voucher);
    // the day is over: the broker writes the bill of the real cost; the lessee signs it, up to the cap
    const dayStart = Math.floor(rig.chain.now / DAY) * DAY;
    const grant = rig.chain.grants.get(6);
    const bill1 = await rig.manager.settleDay(grant, dayStart);
    expect(bill1).toEqual({ amount: 1_200_000n, overCap: false });
    const billed = agent.daily.signBill({ billed: bill1.amount.toString(), epoch: 42, state: book.state() });
    book.take(billed);
    expect(billed).toMatchObject({ resource: "x207:grant:6:cost", cumulativeAmount: (BigInt(PRICE) + 1_200_000n).toString() });
    expect(verifyVoucher(billed, keys.publicKey)).toBe(true);
    // the next day costs 3 credit, above the cap of 2: the broker closes the access, the SDK refuses to sign the bill and the rent stops
    rig.chain.now += DAY;
    cost = 3_000_000n;
    const bill2 = await rig.manager.settleDay(rig.chain.grants.get(6), Math.floor(rig.chain.now / DAY) * DAY);
    expect(bill2).toEqual({ amount: 3_000_000n, overCap: true });
    expect(() => agent.daily.signBill({ billed: bill2.amount.toString(), epoch: 42, state: book.state() })).toThrowError(/rent_bill_over_cap/);
    expect(agent.daily.stopped).toBe(true);
    expect((await agent.view()).status).toBe("revoked");
    expect(book.state().cumulativeAmount).toBe((BigInt(PRICE) + 1_200_000n).toString()); // the over-cap bill was not signed
  });
});
