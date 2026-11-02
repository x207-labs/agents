// AG-015: bagian murni skenario kelas B (tanpa jaringan): kunci akses, scope, urutan transaksi, dan penilaian hasil probe. Alur lengkap di near-sandbox
// ada di demo/classb.demo.ts (npm run demo:classb).
import { describe, expect, it } from "vitest";
import { base58Decode, parseFunctionCallKeyScope, voucherPublicKey, type ContractCall } from "@x207/core";
import {
  CLASS_B_ASSET_TYPE, acceptRental, assertProbe, newAccessKey, offerRental, payLease, probeKey, rentalScope, type CallWithKey, type KeyProbe,
} from "../scenario/classb.ts";

describe("AG-015 skenario kelas B", () => {
  it("newAccessKey: format NEAR 64 byte (seed + publik), publik cocok dengan seed, deterministik untuk seed yang sama", () => {
    const seed = new Uint8Array(32).fill(7);
    const key = newAccessKey(seed);
    const secret = base58Decode(key.secretKey.slice("ed25519:".length));
    expect(secret).toHaveLength(64);
    expect([...secret.subarray(0, 32)]).toEqual([...seed]);
    expect(key.publicKey).toBe(voucherPublicKey(seed));
    expect(newAccessKey(seed)).toEqual(key);
    expect(newAccessKey().publicKey).not.toBe(newAccessKey().publicKey);
  });

  it("rentalScope lolos parser scope kelas B dari @x207/core", () => {
    expect(parseFunctionCallKeyScope(rentalScope("circle.near", ["get_params"]))).toEqual({
      receiver_id: "circle.near", method_names: ["get_params"], allowance: "1000000000000000000000000",
    });
  });

  it("offerRental dan acceptRental mengirim argumen persis: unit day, operator broker, delivery_pubkey milik penyewa", async () => {
    const sent: ContractCall[] = [];
    const send = async (call: ContractCall) => {
      sent.push(call);
      return call.methodName === "offer_grant" ? 12 : undefined;
    };
    const grantId = await offerRental({ send, contract: "circle.near", scope: rentalScope("circle.near", ["get_params"]), unitPrice: "50000", operator: "broker.near", expiresAtMs: 1_800_000_000_000 });
    expect(grantId).toBe(12);
    expect(sent[0]).toMatchObject({ receiverId: "circle.near", methodName: "offer_grant", deposit: 0n });
    expect((sent[0]!.args as any).input).toMatchObject({
      asset_type: CLASS_B_ASSET_TYPE, delivery_method: "near_access_key", unit: "day", unit_price: "50000", operator: "broker.near",
      limits: { quota: null, expires_at: "1800000000000000000" }, proof_hash: null, proof_kind: null,
    });
    const key = await acceptRental({ send, contract: "circle.near", grantId });
    expect(sent[1]).toMatchObject({ methodName: "accept_grant", args: { grant_id: 12, delivery_pubkey: key.publicKey } });
    expect(JSON.stringify(sent, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(key.secretKey);
  });

  it("payLease memanggil /grants/{id}/lease lewat fetch pembeli dan membaca status, badan dan PAYMENT-RESPONSE", async () => {
    const urls: string[] = [];
    const buy = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ grantId: 3, publicKey: "ed25519:x" }), { status: 200, headers: { "PAYMENT-RESPONSE": "abc" } });
    }) as unknown as typeof fetch;
    expect(await payLease({ buy, brokerUrl: "http://broker", grantId: 3 })).toEqual({ status: 200, body: { grantId: 3, publicKey: "ed25519:x" }, paymentResponse: true });
    expect(urls).toEqual(["http://broker/grants/3/lease"]);
  });

  it("probeKey dan assertProbe: sah jalan, method lain dan deposit ditolak; hasil lain gagal", async () => {
    const calls: Array<[string, bigint]> = [];
    const call: CallWithKey = async (_key, method, deposit) => {
      calls.push([method, deposit]);
      return method === "get_params" && deposit === 0n ? { ok: true, hash: "h" } : { ok: false, error: "tolak" };
    };
    const probe = await probeKey(call, newAccessKey(), "get_params", "get_epoch");
    expect(calls).toEqual([["get_params", 0n], ["get_epoch", 0n], ["get_params", 1n]]);
    expect(() => assertProbe(probe)).not.toThrow();
    const ok = { ok: true, hash: "h" } as const;
    const no = { ok: false, error: "x" } as const;
    expect(() => assertProbe({ allowed: no, otherMethod: no, withDeposit: no } satisfies KeyProbe)).toThrow(/diizinkan gagal/);
    expect(() => assertProbe({ allowed: ok, otherMethod: ok, withDeposit: no })).toThrow(/method di luar/);
    expect(() => assertProbe({ allowed: ok, otherMethod: no, withDeposit: ok })).toThrow(/deposit/);
  });
});
