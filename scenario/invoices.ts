// Skenario `realworld` (AG-021, K-59; format SDK sejak AG-025): tiga bisnis saling punya invoice. Tiap invoice dicatat sebagai voucher kumulatif debitur ke
// kreditur dengan `resource = x207:invoice:<sha256 invoice>` (hash invoice off-chain; isi invoice tidak masuk rantai). Kliring F3 menghapus
// utang melingkar dan selisihnya masuk jalur residual F4. Tidak ada kontrak baru: hanya voucher dan kliring yang sudah ada.
import { invoiceHash as sdkInvoiceHash, invoiceResource as sdkInvoiceResource, signVoucher, type InvoiceDocument, type Voucher } from "@x207/core";

const CREDIT = 1_000_000n;
export const credit = (n: number | bigint): string => (BigInt(n) * CREDIT).toString();

/** Invoice: `issuer` menagih `debtor` sebesar `amount` (satuan terkecil credit) untuk `memo`. Sama dengan dokumen invoice SDK (SD-065). */
export type Invoice = InvoiceDocument;

/** Hash invoice menurut SDK: sha256 atas JSON kanonik `{id, issuer, debtor, amount, memo}`; heks huruf kecil 64 karakter. */
export const invoiceHash = (invoice: Invoice): string => sdkInvoiceHash(invoice);

/** `resource` voucher invoice: `x207:invoice:<hash>` (format SDK; skenario AG-021 lama memakai `invoice:<hash>`). */
export const invoiceResource = (invoice: Invoice): string => sdkInvoiceResource(sdkInvoiceHash(invoice));

/** Tiga bisnis: pemasok (supplier), pabrik (maker), pengecer (retailer). Utang melingkar maker -> supplier -> retailer -> maker. */
export type Businesses = { supplier: string; maker: string; retailer: string };

export function sampleInvoices(b: Businesses): Invoice[] {
  return [
    { id: "INV-2026-001", issuer: b.supplier, debtor: b.maker, amount: credit(100), memo: "components, October batch" },
    { id: "INV-2026-002", issuer: b.retailer, debtor: b.supplier, amount: credit(60), memo: "storefront ads and returns handling" },
    { id: "INV-2026-003", issuer: b.maker, debtor: b.retailer, amount: credit(80), memo: "finished goods, October batch" },
  ];
}

export type InvoiceVoucher = { invoice: Invoice; hash: string; voucher: Omit<Voucher, "signature">; signature: Voucher["signature"] };

/**
 * Satu voucher kumulatif per invoice, ditandatangani debitur. Invoice untuk pasangan (debitur, kreditur) yang sama menaikkan `seq`
 * dan `cumulativeAmount`; yang didaftarkan ke kontrak adalah voucher terakhir tiap pasangan.
 */
export function buildInvoiceVouchers(args: {
  circle: string;
  epoch: number;
  invoices: readonly Invoice[];
  secretKeys: Readonly<Record<string, `ed25519:${string}`>>;
}): InvoiceVoucher[] {
  const progress = new Map<string, { seq: number; cumulative: bigint }>();
  return args.invoices.map((invoice) => {
    const key = `${invoice.debtor}>${invoice.issuer}`;
    const previous = progress.get(key) ?? { seq: 0, cumulative: 0n };
    const next = { seq: previous.seq + 1, cumulative: previous.cumulative + BigInt(invoice.amount) };
    progress.set(key, next);
    const secretKey = args.secretKeys[invoice.debtor];
    if (!secretKey) throw new Error(`no voucher key for debtor ${invoice.debtor}`);
    const { signature, ...voucher } = signVoucher(
      {
        circle: args.circle, payer: invoice.debtor, payee: invoice.issuer, epoch: args.epoch, seq: next.seq,
        cumulativeAmount: next.cumulative.toString(), unit: "credit", resource: invoiceResource(invoice),
      },
      secretKey,
    );
    return { invoice, hash: invoiceHash(invoice), voucher, signature };
  });
}

/** Voucher terakhir tiap pasangan (debitur, kreditur), urutan pertama kemunculan; itulah yang didaftarkan on-chain. */
export function latestPerPair(vouchers: readonly InvoiceVoucher[]): InvoiceVoucher[] {
  const latest = new Map<string, InvoiceVoucher>();
  for (const v of vouchers) latest.set(`${v.voucher.payer}>${v.voucher.payee}`, v);
  return [...latest.values()];
}

export type Edge = { debtor: string; creditor: string; amount: bigint };

export type Netting = {
  /** Total semua utang sebelum kliring. */
  before: bigint;
  /** Total yang dihapus kliring (jumlah di semua edge siklus). */
  cleared: bigint;
  /** Total yang tersisa setelah kliring. */
  after: bigint;
  /** Edge sisa setelah kliring; inilah yang masuk jalur residual F4. */
  residual: Edge[];
  /** Posisi bersih tiap akun: piutang − utang; tidak berubah oleh kliring. */
  net: Record<string, bigint>;
  /** Total yang benar-benar berpindah lewat jalur residual F4: jumlah posisi bersih positif (= jumlah negatif). */
  settlement: bigint;
};

/** Edge utang dari invoice, digabung per pasangan (debitur, kreditur). */
export function edgesOf(invoices: readonly Invoice[]): Edge[] {
  const merged = new Map<string, Edge>();
  for (const i of invoices) {
    const key = `${i.debtor}>${i.issuer}`;
    const found = merged.get(key);
    if (found) found.amount += BigInt(i.amount);
    else merged.set(key, { debtor: i.debtor, creditor: i.issuer, amount: BigInt(i.amount) });
  }
  return [...merged.values()];
}

/**
 * Pembatalan siklus berulang: cari siklus, kurangi semua edge di siklus dengan edge terkecilnya, ulangi sampai graf tanpa siklus.
 * Untuk cincin tunggal hasilnya persis kliring kontrak (jumlah siklus = edge terkecil); graf dengan banyak siklus yang saling
 * tumpang tindih bisa punya lebih dari satu hasil, jadi angka akhir yang dipakai tetap posisi dari kontrak (lihat tes sandbox).
 */
export function netInvoices(invoices: readonly Invoice[]): Netting {
  const edges = edgesOf(invoices).map((e) => ({ ...e }));
  const before = edges.reduce((n, e) => n + e.amount, 0n);
  const net: Record<string, bigint> = {};
  for (const e of edges) {
    net[e.debtor] = (net[e.debtor] ?? 0n) - e.amount;
    net[e.creditor] = (net[e.creditor] ?? 0n) + e.amount;
  }

  const findCycle = (): Edge[] | null => {
    const live = edges.filter((e) => e.amount > 0n);
    const visit = (node: string, path: Edge[], seen: Set<string>): Edge[] | null => {
      for (const e of live.filter((x) => x.debtor === node)) {
        const start = path.findIndex((p) => p.debtor === e.creditor);
        if (start >= 0) return [...path.slice(start), e];
        if (seen.has(e.creditor)) continue;
        seen.add(e.creditor);
        const found = visit(e.creditor, [...path, e], seen);
        if (found) return found;
      }
      return null;
    };
    for (const e of live) {
      const found = visit(e.debtor, [], new Set([e.debtor]));
      if (found) return found;
    }
    return null;
  };

  let cleared = 0n;
  for (let cycle = findCycle(); cycle; cycle = findCycle()) {
    const least = cycle.reduce((m, e) => (e.amount < m ? e.amount : m), cycle[0]!.amount);
    for (const e of cycle) e.amount -= least;
    cleared += least * BigInt(cycle.length);
  }
  const residual = edges.filter((e) => e.amount > 0n);
  const settlement = Object.values(net).filter((v) => v > 0n).reduce((a, b) => a + b, 0n);
  return { before, cleared, after: before - cleared, residual, net, settlement };
}

/** Baris laporan yang dicetak skenario: total sebelum dan sesudah netting dalam credit utuh. */
export function formatNetting(n: Netting): string[] {
  const fmt = (v: bigint) => (Number(v) / Number(CREDIT)).toString();
  return [
    `invoice total before netting: ${fmt(n.before)} credit`,
    `cleared by cycle netting:    ${fmt(n.cleared)} credit`,
    `invoice total after netting:  ${fmt(n.after)} credit (residual edges)`,
    ...n.residual.map((e) => `  residual ${e.debtor} -> ${e.creditor}: ${fmt(e.amount)} credit`),
    `net cash settled through F4:  ${fmt(n.settlement)} credit`,
  ];
}
