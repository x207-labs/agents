// What the contract and the indexer do for a registered voucher, played in the database of the test backend: the raw event `voucher_registered` (NEP-297 `data` is an array of one object)
// and the obligation row (monotonic in `seq`). Copied from the backend tests on purpose: importing a test helper of another repository breaks when that repository moves it.
import { CIRCLE_ID, CONTRACT, acct } from "./market.ts";

type Db = { prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
type Market = { db: Db };

let receipt = 0;

const ensureEpoch = (m: Market, epoch: number, phase: string): void => {
  if (m.db.prepare("SELECT 1 FROM epochs WHERE circle_id = ? AND epoch = ?").get(CIRCLE_ID, epoch)) return;
  m.db.prepare("INSERT INTO epochs (circle_id, epoch, phase, cleared_total) VALUES (?, ?, ?, 0)").run(CIRCLE_ID, epoch, phase);
};

/** The voucher of `payer` to `payee` is registered on the contract: the event and the obligation row. Creates the epoch row (open) when it is missing. */
export function chainVoucher(m: Market, v: { payer: string; payee: string; epoch: number; seq: number; cumulative: string }): void {
  ensureEpoch(m, v.epoch, "open");
  m.db
    .prepare(
      `INSERT INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, tx_hash, contract_id, standard, version, event, data_json, handled)
       VALUES (?, 0, 1, 'h', 1, ?, ?, 'x207', '0.0.1', 'voucher_registered', ?, 1)`,
    )
    .run(`r${++receipt}`, `tx${receipt}`, CONTRACT, JSON.stringify([{ payer: acct(v.payer), payee: acct(v.payee), epoch: v.epoch, seq: v.seq, cumulative_amount: v.cumulative, delta: "0", obligation: v.cumulative, outstanding_debt: "0", mode: "cumulative" }]));
  const old = m.db.prepare("SELECT seq FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").get(CIRCLE_ID, v.epoch, acct(v.payer), acct(v.payee)) as { seq: number } | undefined;
  if (!old) {
    m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, ?, ?, ?, ?, ?, NULL, 'cumulative', 1, 'r')").run(CIRCLE_ID, v.epoch, acct(v.payer), acct(v.payee), v.seq, v.cumulative);
  } else if (v.seq > old.seq) {
    m.db.prepare("UPDATE obligations SET seq = ?, cumulative_amount = ? WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").run(v.seq, v.cumulative, CIRCLE_ID, v.epoch, acct(v.payer), acct(v.payee));
  }
}

/** The epoch is over: its row is there and its phase left `open`. */
export function closeEpoch(m: Market, epoch: number): void {
  ensureEpoch(m, epoch, "finalized");
  m.db.prepare("UPDATE epochs SET phase = 'finalized' WHERE circle_id = ? AND epoch = ?").run(CIRCLE_ID, epoch);
}
