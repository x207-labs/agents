// Scenario with one asset per class in the contract (AG-022, F8). This file lives in `test/` because what it sends are owner actions (token deposit, grant acceptance),
// outside the AG-007 agent policy that forbids the `scenario/` folder from sending transactions with a deposit.
// Content: the D10 registry already holds the catalog, then class A (mock RWA token with a whitelist), B (NEAR access key),
// C (API key through a proxy), and D (GPU hours) are each created as a grant, and one class X asset is rejected. Only the contract is used; the broker, facilitator, and
// mock provider are not involved, so for B to D what is proven is the offer and acceptance in D11, not the delivery of the access (that is in the broker test).
// `assertBuyerRegisteredAtToken` (SD-060) is not called here because `probes/mock_rwa` has no `storage_balance_of` view yet; on a real token that helper is used before buying.
// Class A is settled until the token moves: a buyer not yet on the whitelist fails and the payment is cancelled; once whitelisted it succeeds.
import { buildFtEscrowDepositCall, ftEscrowGrantScope, signVoucher, type AccountId, type ContractCall } from "@x207/core";


export type SendResult = { failures: string[]; logs: string[]; value: unknown };
export type ClassScenarioPorts = {
  /** Send one call as `account`; a failure is returned, not thrown. */
  send(account: AccountId, call: ContractCall & { gas?: bigint }): Promise<SendResult>;
  /** View on any contract (circle contract or token). */
  view(contractId: AccountId, methodName: string, args: object): Promise<unknown>;
};
export type ClassScenarioActors = {
  circle: AccountId;
  /** Mock RWA token contract (`probes/mock_rwa`). */
  token: AccountId;
  grantor: AccountId;
  buyer: AccountId;
  /** Buyer voucher key (for `complete_escrow`). */
  buyerVoucherKey: `ed25519:${string}`;
  /** Public key of the function-call key requested by the class B grant recipient. */
  deliveryPubkey: string;
  epoch: number;
};
export type ClassStep = { assetClass: "A" | "B" | "C" | "D" | "X"; assetType: string; step: string; ok: boolean; detail: string };

const DAY_NS = 86_400_000_000_000n;
export const RWA_AMOUNT = "1000";
export const RWA_PRICE = "10000000";

/** NEP-297 event name from a log line (`EVENT_JSON:{...}`); other lines are ignored. */
const eventsOf = (logs: string[]): string[] =>
  logs.flatMap((line) => {
    try {
      const name = (JSON.parse(line.replace(/^EVENT_JSON:/, "")) as { event?: unknown }).event;
      return typeof name === "string" ? [name] : [];
    } catch {
      return [];
    }
  });

export async function runClassScenario(p: ClassScenarioPorts, a: ClassScenarioActors): Promise<ClassStep[]> {
  const steps: ClassStep[] = [];
  const expires = (BigInt(Date.now()) * 1_000_000n + DAY_NS).toString();
  const offerInput = (assetType: string, deliveryMethod: string, scope: string, unit: string, price: string) => ({
    input: { asset_type: assetType, delivery_method: deliveryMethod, limits: { scope, quota: null, expires_at: expires }, unit, unit_price: price, operator: null, proof_hash: null, proof_kind: null },
  });
  const offer = (assetType: string, deliveryMethod: string, scope: string, unit: string, price: string) =>
    p.send(a.grantor, { receiverId: a.circle, methodName: "offer_grant", args: offerInput(assetType, deliveryMethod, scope, unit, price), deposit: 0n });
  const grant = async (id: number) => (await p.view(a.circle, "get_grant", { grant_id: id })) as { status: string; class: string } | null;
  const note = (assetClass: ClassStep["assetClass"], assetType: string, step: string, ok: boolean, detail: string) => steps.push({ assetClass, assetType, step, ok, detail });

  // ---- A: token RWA with a whitelist: the exact amount is held, a buyer outside the whitelist fails and is paid back, a whitelisted buyer gets the tokens
  const rwa = "rwa:tokenized";
  const offered = await offer(rwa, "escrow_ft", ftEscrowGrantScope(a.token, RWA_AMOUNT), "once", RWA_PRICE);
  const id = Number(offered.value);
  note("A", rwa, "offer_grant", offered.failures.length === 0 && id > 0, offered.failures.join("; ") || `grant ${id}`);
  const deposited = await p.send(a.grantor, { ...buildFtEscrowDepositCall({ circleContract: a.circle, ftContract: a.token, amount: RWA_AMOUNT, grantId: id }), gas: 150_000_000_000_000n });
  const held = (await p.view(a.circle, "get_ft_escrow", { grant_id: id })) as { state: string; amount: string } | null;
  note("A", rwa, "ft_transfer_call escrow", held?.state === "held" && held.amount === RWA_AMOUNT && eventsOf(deposited.logs).includes("ft_escrow_held"), `escrow ${held?.state ?? "none"}`);

  await p.send(a.grantor, { receiverId: a.token, methodName: "set_whitelist_on", args: { on: true }, deposit: 0n });
  await p.send(a.grantor, { receiverId: a.token, methodName: "set_whitelisted", args: { account_id: a.grantor, whitelisted: true }, deposit: 0n });
  await p.send(a.grantor, { receiverId: a.token, methodName: "set_whitelisted", args: { account_id: a.circle, whitelisted: true }, deposit: 0n });
  const buy = () => {
    const { signature, ...voucher } = signVoucher(
      { circle: a.circle, payer: a.buyer, payee: a.grantor, epoch: a.epoch, seq: 1, cumulativeAmount: RWA_PRICE, unit: "credit", resource: `https://x207.example/grants/${id}` },
      a.buyerVoucherKey,
    );
    return p.send(a.buyer, { receiverId: a.circle, methodName: "complete_escrow", args: { grant_id: id, voucher, signature }, deposit: 0n, gas: 250_000_000_000_000n });
  };
  const refused = await buy();
  const afterRefusal = await grant(id);
  const obligation = await p.view(a.circle, "obligation", { epoch: a.epoch, debtor: a.buyer, creditor: a.grantor });
  note(
    "A", rwa, "buyer outside the whitelist",
    eventsOf(refused.logs).includes("escrow_failed") && afterRefusal?.status === "offered" && obligation === null,
    `grant ${afterRefusal?.status ?? "none"}, obligation ${obligation === null ? "none" : "kept"}, events [${eventsOf(refused.logs).join(",")}]${refused.failures.length ? `, failures ${refused.failures.join(" | ").slice(0, 200)}` : ""}`,
  );

  await p.send(a.grantor, { receiverId: a.token, methodName: "set_whitelisted", args: { account_id: a.buyer, whitelisted: true }, deposit: 0n });
  const delivered = await buy();
  const escrow = (await p.view(a.circle, "get_ft_escrow", { grant_id: id })) as { state: string } | null;
  const balance = String(await p.view(a.token, "ft_balance_of", { account_id: a.buyer }));
  note("A", rwa, "whitelisted buyer", delivered.failures.length === 0 && escrow?.state === "delivered" && balance === RWA_AMOUNT, `escrow ${escrow?.state ?? "none"}, buyer holds ${balance}${delivered.failures.length ? `, failures ${delivered.failures.join(" | ").slice(0, 200)}` : ""}`);

  // ---- B, C, D: offer and accept
  const accept = async (assetClass: "B" | "C" | "D", assetType: string, delivery: string, scope: string, unit: string, price: string, pubkey: string | null) => {
    const o = await offer(assetType, delivery, scope, unit, price);
    const gid = Number(o.value);
    const ok = o.failures.length === 0 && gid > 0;
    note(assetClass, assetType, "offer_grant", ok, o.failures.join("; ") || `grant ${gid}`);
    if (!ok) return;
    const r = await p.send(a.buyer, { receiverId: a.circle, methodName: "accept_grant", args: { grant_id: gid, delivery_pubkey: pubkey }, deposit: 0n });
    const g = await grant(gid);
    note(assetClass, assetType, "accept_grant", r.failures.length === 0 && g?.status === "active" && g.class === assetClass, `grant ${g?.status ?? "none"} class ${g?.class ?? "none"}`);
  };
  await accept("B", "near-rpc:access", "near_access_key", JSON.stringify({ receiver_id: a.circle, method_names: ["get_params"], allowance: "1000000000000000000000000" }), "day", "50000", a.deliveryPubkey);
  await accept("C", "api:delegated-key", "proxy", JSON.stringify({ upstream: "https://api.example", quota: 100 }), "call", "20000", null);
  await accept("D", "compute:gpu-hours", "x402_endpoint", "{}", "minute", "10000", null);

  // ---- X: refused
  const refusedX = await offer("securities:equity", "none", "{}", "once", "1000");
  note("X", "securities:equity", "offer_grant", refusedX.failures.join(" ").includes("ERR_ASSET_CLASS_FORBIDDEN"), refusedX.failures.join("; ") || "accepted (wrong)");
  return steps;
}
