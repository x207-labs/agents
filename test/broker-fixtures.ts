// The access broker as the agent tests use it: its source (`backend/broker/src`) is loaded by path, the test folder of that repo never. A chain that holds grants in memory, a facilitator
// that accepts every voucher, and the broker handler with a mock provider, an SSH provider on an in-memory `authorized_keys`, and a costly mock (a cloud role). Skipped when the
// backend repo is missing (CI of agents stands alone).
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BACKEND_AVAILABLE, BACKEND_DIR } from "./backend-fixtures.ts";

export const BROKER_DIR = `${BACKEND_DIR}broker/`;
export const BROKER_AVAILABLE = BACKEND_AVAILABLE && existsSync(`${BROKER_DIR}src/index.ts`);

export const CIRCLE = "x207-circle.near";
export const GRANTOR = "scraper.x207-circle.near";
export const GRANTEE = "translator.x207-circle.near";
export const BROKER_ACCOUNT = "broker.x207-circle.near";
export const DAY = 86_400_000;
export const START = Date.parse("2026-11-05T10:00:00Z");
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

export const loadBroker = (): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BROKER_DIR}src/index.ts`).href);

export type Rig = Awaited<ReturnType<typeof startBroker>>;

/** One broker with a mock chain; `adapters` are registered at the provider manager. The chain clock is `rig.chain.now` (ms) and moves by hand. */
export async function startBroker(register: (b: any, rig: { now: () => number }) => any[]) {
  const b = await loadBroker();
  const chain = {
    leaseAccount: "lease.scraper.x207-circle.near",
    grants: new Map<number, any>(),
    now: START,
    epoch: 42,
    async getGrant(id: number) { return this.grants.get(id) ?? null; },
    async addLeaseKey() { return "tx-add"; },
    async deleteLeaseKey() { return "tx-delete"; },
    async revokeGrant(id: number, reason: string) {
      const g = this.grants.get(id);
      if (g) this.grants.set(id, { ...g, status: reason === "expired" ? "expired" : "revoked" });
      return { ok: true as const, txHash: "tx-revoke" };
    },
    async currentEpoch() { return this.epoch; },
    async nowMs() { return this.now; },
  };
  const store = new b.BrokerStore(":memory:");
  const classB = new b.ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const dispatcher = new b.Dispatcher({ chain, adapters: { B: classB } });
  const manager = new b.ProviderAccessManager({ store, now: () => chain.now, circle: CIRCLE });
  const adapters = register(b, { now: () => chain.now });
  for (const adapter of adapters) manager.register(adapter);
  const keys = new Map<string, string>();
  const fetchFn = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: CIRCLE, epoch: 42 } }] });
    if (path === "/verify") return reply({ isValid: true });
    if (path === "/settle") return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const handler = b.createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER_ACCOUNT, fetch: fetchFn,
    provider: { manager, contractId: CIRCLE, now: () => chain.now, voucherKeyOf: async (a: string) => keys.get(a) ?? null },
  });
  /** The agent's fetch: the broker handler is the server. */
  const brokerFetch = (input: string, init?: RequestInit): Promise<Response> => handler(new Request(input, init));
  const grant = (id: number, scope: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    chain.grants.set(id, {
      grant_id: id, asset_type: "access:rent", grantor: GRANTOR, grantee: GRANTEE, class: "B",
      limits: { scope: JSON.stringify(scope), quota: null, expires_at: NS(START + 30 * DAY) }, unit: "day", unit_price: "250000", operator: BROKER_ACCOUNT,
      delivery_pubkey: "ed25519:7YkYUwHgD8gM4tUQbkcGzMfqMPXK9RSTkUmqm9Fa8qpT", status: "active", proof_hash: null, proof_kind: null, ...over,
    });
    return chain.grants.get(id);
  };
  return { b, chain, manager, brokerFetch, grant, registerVoucherKey: (account: string, key: string) => void keys.set(account, key), adapters };
}
