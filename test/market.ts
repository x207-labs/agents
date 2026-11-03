// Buku marketplace backend (M11) berjalan di dalam proses untuk test agent: database D9 dalam memori, anggota dengan kunci voucher agent,
// satu epoch `open`, dan route marketplace asli. Dimuat lewat import dinamis supaya typecheck agents tidak mengikuti kode backend,
// dan test dilewati bila repo backend tidak ada (CI agents berdiri sendiri).
import { pathToFileURL } from "node:url";
import { generateVoucherKeypair, type BundleTerms } from "@x207/core";
import { BookClient } from "../shared/barter.ts";
import type { AgentIdentity } from "../shared/identity.ts";
import { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct, listen, openDatabase, seedEpoch, seedMember } from "./backend-fixtures.ts";

export { BACKEND_AVAILABLE, BACKEND_DIR, CIRCLE_ID, CONTRACT, acct };

const load = (path: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${BACKEND_DIR}${path}`).href);

export type MarketBook = {
  book: BookClient;
  /** URL dasar read API. */
  url: string;
  identities: Record<string, AgentIdentity>;
  db: any;
  /** Waktu server dalam ms; geser untuk menguji kedaluwarsa. */
  clock: { now: number };
  /** Stand-in keluaran solver (SV-010): simpan usulan bundle melingkar yang belum ditandatangani siapa pun. */
  injectProposal(terms: BundleTerms): Promise<string>;
  setEpochPhase(phase: string): void;
  stop(): Promise<void>;
};

export async function startMarketBook(names: readonly string[], options: { now?: number } = {}): Promise<MarketBook> {
  const [marketplace, core] = await Promise.all([load("src/marketplace/index.ts"), import("@x207/core")]);
  const db = await openDatabase();
  const identities: Record<string, AgentIdentity> = {};
  for (const name of names) {
    const keys = generateVoucherKeypair();
    seedMember(db, name, keys.publicKey);
    identities[name] = {
      accountId: acct(name),
      voucherSecretKey: keys.secretKey,
      voucherPublicKey: keys.publicKey,
      policy: { maxPerCall: "100000", maxPerEpoch: "10000000" },
    };
  }
  seedEpoch(db, 42, "open", "2026-12-31T00:00:00Z");
  const clock = { now: options.now ?? Date.now() };
  const server = await listen({ db, now: () => clock.now, extraRoutes: marketplace.marketplaceRoutes(db) });
  return {
    book: new BookClient({ baseUrl: server.url, circleId: CIRCLE_ID }),
    url: server.url,
    identities,
    db,
    clock,
    async injectProposal(terms) {
      const hash = core.termsHash(terms);
      const match = db
        .prepare(
          `INSERT INTO matches (circle_id, listing_hash, offer_hash, seller, counterparty, mode, kind, epoch, terms_hash, listing_value, discount_value, searcher_value, matched_at_ms)
           VALUES (?, ?, ?, ?, ?, 'barter', 'bundle', ?, ?, '0', '0', '0', ?)`,
        )
        .run(CIRCLE_ID, `ring-${hash}`, `ring-${hash}`, terms.legs[0]!.payer, terms.legs[0]!.payee, terms.epoch, hash, clock.now);
      db.prepare("INSERT INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)").run(
        CIRCLE_ID, hash, match.lastInsertRowid, terms.epoch, JSON.stringify(terms), clock.now,
      );
      return hash;
    },
    setEpochPhase: (phase) => void db.prepare("UPDATE epochs SET phase = ?").run(phase),
    async stop() {
      await server.close();
      db.close();
    },
  };
}
