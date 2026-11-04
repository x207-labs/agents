// `realworld` scenario (AG-021, K-59; SDK format since AG-025): three businesses owe each other invoices. Each invoice is recorded as a cumulative voucher from the debtor to the
// creditor with `resource = x207:invoice:<sha256 invoice>` (the invoice hash is off-chain; the invoice content never goes on-chain). F3 clearing removes
// circular debt and the difference goes to the F4 residual path. No new contract: only the existing vouchers and clearing.
import { invoiceHash as sdkInvoiceHash, invoiceResource as sdkInvoiceResource, signVoucher, type InvoiceDocument, type Voucher } from "@x207/core";

const CREDIT = 1_000_000n;
export const credit = (n: number | bigint): string => (BigInt(n) * CREDIT).toString();

/** Invoice: `issuer` bills `debtor` for `amount` (credit smallest unit) for `memo`. Same as the SDK invoice document (SD-065). */
export type Invoice = InvoiceDocument;

/** Invoice hash per the SDK: sha256 over the canonical JSON `{id, issuer, debtor, amount, memo}`; 64 lowercase hex characters. */
export const invoiceHash = (invoice: Invoice): string => sdkInvoiceHash(invoice);

/** Invoice voucher `resource`: `x207:invoice:<hash>` (SDK format; the old AG-021 scenario used `invoice:<hash>`). */
export const invoiceResource = (invoice: Invoice): string => sdkInvoiceResource(sdkInvoiceHash(invoice));

/** Three businesses: supplier, maker, retailer. Circular debt maker -> supplier -> retailer -> maker. */
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
 * One cumulative voucher per invoice, signed by the debtor. Invoices for the same (debtor, creditor) pair raise `seq`
 * and `cumulativeAmount`; what gets registered with the contract is the last voucher of each pair.
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

/** The last voucher of each (debtor, creditor) pair, in order of first appearance; that is what gets registered on-chain. */
export function latestPerPair(vouchers: readonly InvoiceVoucher[]): InvoiceVoucher[] {
  const latest = new Map<string, InvoiceVoucher>();
  for (const v of vouchers) latest.set(`${v.voucher.payer}>${v.voucher.payee}`, v);
  return [...latest.values()];
}

export type Edge = { debtor: string; creditor: string; amount: bigint };

export type Netting = {
  /** Total of all debt before clearing. */
  before: bigint;
  /** Total removed by clearing (the sum over all edges of the cycles). */
  cleared: bigint;
  /** Total remaining after clearing. */
  after: bigint;
  /** Edges left after clearing; these enter the F4 residual path. */
  residual: Edge[];
  /** Net position of each account: receivable − debt; unchanged by clearing. */
  net: Record<string, bigint>;
  /** Total that actually moves through the F4 residual path: the sum of positive net positions (= the sum of negative ones). */
  settlement: bigint;
};

/** Debt edges from the invoices, merged per (debtor, creditor) pair. */
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
 * Repeated cycle cancellation: find a cycle, reduce every edge in the cycle by its smallest edge, repeat until the graph has no cycle.
 * For a single ring the result is exactly the contract clearing (cycle amount = smallest edge); a graph with many overlapping
 * cycles can have more than one result, so the final figures used are still the positions from the contract (see the sandbox test).
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

/** Report lines printed by the scenario: totals before and after netting in whole credits. */
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
