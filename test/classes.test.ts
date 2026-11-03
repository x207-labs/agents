import { describe, expect, it } from "vitest";
import type { ContractCall } from "@x207/core";
import { RWA_AMOUNT, RWA_PRICE, runClassScenario, type ClassScenarioActors, type ClassScenarioPorts } from "../scenario/classes.ts";

const A = "alice.near";
const B = "bob.near";
const actors: ClassScenarioActors = {
  circle: "circle.near", token: "rwa.near", grantor: A, buyer: B,
  buyerVoucherKey: "ed25519:2vfSUHUpKQ1sZSmt2GA6q7iuUTE1FGv9EhrYRM9KX93Pv8iVBW46BkSkZ6qkJy5eJXrr5fAPmZ8L63hMyCCwYjYW",
  deliveryPubkey: "ed25519:AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9", epoch: 1,
};

/** A circle in memory that answers like the contract in the cases of the scenario. */
function fakeCircle(options: { classXAccepted?: boolean } = {}) {
  const sent: Array<{ account: string; method: string; args: any }> = [];
  const grants = new Map<number, { status: string; class: string }>();
  let nextId = 1;
  let whitelisted = false;
  let escrow: { state: string; amount: string } | null = null;
  let tokens = 0;
  const classOf: Record<string, string> = { "rwa:tokenized": "A", "near-rpc:access": "B", "api:delegated-key": "C", "compute:gpu-hours": "D" };
  const send: ClassScenarioPorts["send"] = async (account, call: ContractCall) => {
    sent.push({ account, method: call.methodName, args: call.args });
    const ok = (value: unknown = null, logs: string[] = []) => ({ failures: [], logs, value });
    switch (call.methodName) {
      case "offer_grant": {
        const type = (call.args as any).input.asset_type as string;
        if (type === "securities:equity" && !options.classXAccepted) return { failures: ["Smart contract panicked: ERR_ASSET_CLASS_FORBIDDEN: securities:equity"], logs: [], value: null };
        const id = nextId++;
        grants.set(id, { status: "offered", class: classOf[type] ?? "X" });
        return ok(id);
      }
      case "ft_transfer_call":
        escrow = { state: "held", amount: (call.args as any).amount };
        return ok("0", [`EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.9", event: "ft_escrow_held", data: [{ grant_id: 1 }] })}`]);
      case "set_whitelisted":
        if ((call.args as any).account_id === B) whitelisted = true;
        return ok();
      case "complete_escrow":
        if (!whitelisted) return { failures: [], logs: [`EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.9", event: "escrow_failed", data: [{ grant_id: 1 }] })}`], value: null };
        escrow = { state: "delivered", amount: escrow!.amount };
        grants.set(1, { status: "active", class: "A" });
        tokens = Number(RWA_AMOUNT);
        return ok();
      case "accept_grant":
        grants.get((call.args as any).grant_id)!.status = "active";
        return ok();
      default:
        return ok();
    }
  };
  const view: ClassScenarioPorts["view"] = async (_contract, method, args: any) => {
    if (method === "get_grant") return grants.get(args.grant_id) ?? null;
    if (method === "get_ft_escrow") return escrow;
    if (method === "obligation") return whitelisted ? { obligation: RWA_PRICE } : null;
    if (method === "ft_balance_of") return String(tokens);
    return null;
  };
  return { ports: { send, view } as ClassScenarioPorts, sent };
}

describe("AG-022 scenario with one asset of each class", () => {
  it("TC-AG-022-01 every class A to D reaches its end state and the class X offer is refused", async () => {
    const { ports } = fakeCircle();
    const steps = await runClassScenario(ports, actors);
    expect(steps.filter((s) => !s.ok), JSON.stringify(steps.filter((s) => !s.ok))).toEqual([]);
    expect(new Set(steps.map((s) => s.assetClass))).toEqual(new Set(["A", "B", "C", "D", "X"]));
    expect(steps.map((s) => `${s.assetClass} ${s.step}`)).toEqual([
      "A offer_grant", "A ft_transfer_call escrow", "A buyer outside the whitelist", "A whitelisted buyer",
      "B offer_grant", "B accept_grant", "C offer_grant", "C accept_grant", "D offer_grant", "D accept_grant", "X offer_grant",
    ]);
  });

  it("TC-AG-022-02 the token goes in with the exact amount through the builder of the SDK, and the buyer is whitelisted only after the refusal", async () => {
    const { ports, sent } = fakeCircle();
    await runClassScenario(ports, actors);
    const deposit = sent.find((s) => s.method === "ft_transfer_call")!;
    expect(deposit).toMatchObject({ account: A, args: { receiver_id: "circle.near", amount: RWA_AMOUNT, msg: '{"action":"escrow","grant_id":1}' } });
    const methods = sent.map((s) => `${s.account}:${s.method}`);
    expect(methods.indexOf(`${B}:complete_escrow`)).toBeLessThan(methods.lastIndexOf(`${A}:set_whitelisted`));
    expect(sent.filter((s) => s.method === "complete_escrow")).toHaveLength(2);
  });

  it("TC-AG-022-03 a class X offer that the contract would accept is reported as a failed step", async () => {
    const { ports } = fakeCircle({ classXAccepted: true });
    const x = (await runClassScenario(ports, actors)).find((s) => s.assetClass === "X")!;
    expect(x.ok).toBe(false);
    expect(x.detail).toContain("accepted (wrong)");
  });
});
