// The backend as the agent tests use it: its source (`src/`) is loaded by path, the test folder of that repo never. The in-memory database of the circle, the members with real voucher keys, the epoch
// rows and the HTTP server are built here, copied in shape from the fixtures of the backend tests, so that a move or rename in the test folder of the backend repo cannot break the agents CI.
// Loaded by dynamic import so that the typecheck of agents does not follow the backend code; tests skip when the backend repo is missing (CI of agents stands alone).
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateVoucherKeypair } from "@x207/core";

export const BACKEND_DIR = fileURLToPath(new URL("../../backend/", import.meta.url));
export const BACKEND_AVAILABLE = existsSync(`${BACKEND_DIR}src/marketplace/index.ts`) && existsSync(`${BACKEND_DIR}node_modules/better-sqlite3`);

export const CONTRACT = "x207-circle.near";
export const CIRCLE_ID = "agents-main";
export const acct = (name: string): string => `${name}.${CONTRACT}`;

const load = (path: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}${path}`).href);

const ISO_NS = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;

type Db = any;

/** An empty database, migrated, with the circle and the cursor of the indexer. */
export async function openDatabase(lastBlock = 171234567): Promise<Db> {
  const [sqlite, { migrate }] = await Promise.all([load("node_modules/better-sqlite3/lib/index.js"), load("src/db/migrate.ts")]);
  const Database = sqlite.default ?? sqlite;
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES (?, ?, ?)").run(CIRCLE_ID, CONTRACT, `x207:${CIRCLE_ID}`);
  db.prepare(
    `INSERT INTO indexer_cursor (name, contract_id, start_block_height, last_block_height, last_block_hash, last_block_timestamp_ns, head_block_height, lag_blocks, rpc_endpoint, updated_at)
     VALUES (?, ?, 1, ?, 'bh', 1, ?, 0, 'https://rpc.mainnet.fastnear.com', 1)`,
  ).run(CONTRACT, CONTRACT, lastBlock, lastBlock);
  return db;
}

/** A member of the circle with a real voucher key. */
export function seedMember(db: Db, name: string, publicKey: string, status = "active"): void {
  db.prepare(
    `INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, stake, credit_limit, outstanding_debt, status, settled_history, joined_at_ns, exit_requested_epoch, updated_block)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(CIRCLE_ID, acct(name), publicKey, `terms-${name}`, 100_000_000n, 80_000_000n, 0n, status, 0n, ISO_NS("2026-11-03T08:12:44Z"), null);
}

export function seedEpoch(db: Db, epoch: number, phase: string, cutoffAt?: string): void {
  db.prepare("INSERT INTO epochs (circle_id, epoch, phase, cutoff_at_ns, cleared_total) VALUES (?, ?, ?, ?, 0)").run(CIRCLE_ID, epoch, phase, cutoffAt === undefined ? null : ISO_NS(cutoffAt));
}

export type TestServer = { url: string; close: () => Promise<void> };

export async function listen(options: Record<string, unknown>): Promise<TestServer> {
  const { createApiServer } = await load("src/api/server.ts");
  const server = createApiServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export type Market = {
  db: Db;
  srv: TestServer;
  keys: Record<string, ReturnType<typeof generateVoucherKeypair>>;
  /** Server time in ms; tests move it. */
  clock: { now: number };
};

/** The circle with members `names` (real voucher keys), one open epoch 42 and the real marketplace routes; `routeOptions` go to `marketplaceRoutes`. */
export async function startMarket(names: readonly string[], routeOptions: Record<string, unknown> = {}, now = Date.parse("2026-11-04T10:00:00Z")): Promise<Market> {
  const [db, marketplace] = await Promise.all([openDatabase(), load("src/marketplace/index.ts")]);
  const keys: Market["keys"] = {};
  for (const name of names) {
    keys[name] = generateVoucherKeypair();
    seedMember(db, name, keys[name]!.publicKey);
  }
  seedEpoch(db, 42, "open", "2026-11-05T00:00:00Z");
  const clock = { now };
  const srv = await listen({ db, now: () => clock.now, extraRoutes: marketplace.marketplaceRoutes(db, routeOptions) });
  return { db, srv, keys, clock };
}
