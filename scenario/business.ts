// Skenario `business` (AG-020, K-59): agent pengadaan membeli jasa secara kredit tanpa persetujuan per transaksi, tetapi hanya dalam
// batas yang pemilik tetapkan: daftar jasa (allowlist) dengan harga tertinggi per jasa, batas per panggilan, dan anggaran per epoch.
// Pemeriksaan jalan sebelum pembayaran apa pun: harga dibaca dari tantangan 402 penjual, dan voucher baru ditandatangani hanya bila
// semua batas lolos. Pembelian di luar batas ditolak tanpa voucher dan tanpa pertanyaan ke manusia.
import type { SpendPolicy } from "../shared/identity.ts";

export type ProcurementService = {
  /** Nama jasa di daftar pemilik, mis. `translate`. */
  name: string;
  /** URL dasar agent penjual. */
  url: string;
  /** Rute berbayar, mis. `/api/translate`. */
  path: string;
  /** Harga tertinggi per panggilan untuk jasa ini, satuan terkecil credit. */
  maxPrice: string;
};

export type ProcurementPolicy = { spend: SpendPolicy; services: readonly ProcurementService[] };

export type DenialReason =
  | "service_not_allowed"
  | "quote_unavailable"
  | "price_above_service_limit"
  | "over_per_call_limit"
  | "over_epoch_budget";

export type Purchase =
  | { ok: true; service: string; price: string; spentThisEpoch: string; status: number; body: unknown }
  | { ok: false; service: string; reason: DenialReason; detail: Record<string, string> };

export type ProcurementOptions = {
  account: string;
  policy: ProcurementPolicy;
  /** `fetch` yang membayar 402 dengan voucher (createAgentBuyer). */
  pay: typeof fetch;
  /** `fetch` polos untuk membaca tantangan harga; default `fetch` global. */
  quote?: typeof fetch;
};

type Requirement = { scheme?: string; network?: string; amount?: string };

/** Harga x207 dari tantangan 402: entri `batch-settlement` pada jaringan `x207:`; `null` bila tidak ada atau bukan 402. */
export async function readQuote(response: Response): Promise<string | null> {
  if (response.status !== 402) return null;
  let accepts: Requirement[] | undefined;
  const header = response.headers.get("PAYMENT-REQUIRED");
  try {
    if (header) accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Requirement[] }).accepts;
    else accepts = ((await response.clone().json()) as { accepts?: Requirement[] }).accepts;
  } catch {
    return null;
  }
  const entry = accepts?.find((a) => a.scheme === "batch-settlement" && a.network?.startsWith("x207:"));
  return entry?.amount && /^[1-9]\d*$/.test(entry.amount) ? entry.amount : null;
}

export class ProcurementAgent {
  readonly account: string;
  readonly policy: ProcurementPolicy;
  readonly #pay: typeof fetch;
  readonly #quote: typeof fetch;
  #spent = 0n;
  readonly log: Purchase[] = [];

  constructor(options: ProcurementOptions) {
    this.account = options.account;
    this.policy = options.policy;
    this.#pay = options.pay;
    this.#quote = options.quote ?? fetch;
  }

  /** Pengeluaran epoch berjalan, satuan terkecil credit. */
  get spent(): bigint {
    return this.#spent;
  }

  /** Epoch baru: anggaran dimulai dari nol lagi. */
  newEpoch(): void {
    this.#spent = 0n;
  }

  #deny(service: string, reason: DenialReason, detail: Record<string, string> = {}): Purchase {
    const result: Purchase = { ok: false, service, reason, detail };
    this.log.push(result);
    return result;
  }

  /** Beli satu panggilan `service` dengan `input` bila lolos semua batas pemilik. */
  async buy(service: string, input: string): Promise<Purchase> {
    const listed = this.policy.services.find((s) => s.name === service);
    if (!listed) return this.#deny(service, "service_not_allowed");
    const target = `${listed.url}${listed.path}?input=${encodeURIComponent(input)}`;

    const price = await readQuote(await this.#quote(target));
    if (price === null) return this.#deny(service, "quote_unavailable");
    const amount = BigInt(price);
    if (amount > BigInt(listed.maxPrice)) return this.#deny(service, "price_above_service_limit", { price, limit: listed.maxPrice });
    if (amount > BigInt(this.policy.spend.maxPerCall)) return this.#deny(service, "over_per_call_limit", { price, limit: this.policy.spend.maxPerCall });
    if (this.#spent + amount > BigInt(this.policy.spend.maxPerEpoch)) {
      return this.#deny(service, "over_epoch_budget", { price, spent: this.#spent.toString(), limit: this.policy.spend.maxPerEpoch });
    }

    const response = await this.#pay(target);
    if (response.status !== 200) return this.#deny(service, "quote_unavailable", { status: String(response.status) });
    this.#spent += amount;
    const result: Purchase = {
      ok: true, service, price, spentThisEpoch: this.#spent.toString(), status: response.status, body: await response.json().catch(() => null),
    };
    this.log.push(result);
    return result;
  }
}

export type BusinessReport = {
  approved: number;
  denied: Array<{ service: string; reason: DenialReason }>;
  spent: string;
  budget: string;
};

/** Jalankan daftar pembelian berurutan tanpa konfirmasi manusia dan ringkas hasilnya. */
export async function runProcurement(agent: ProcurementAgent, requests: ReadonlyArray<{ service: string; input: string }>): Promise<BusinessReport> {
  const denied: BusinessReport["denied"] = [];
  let approved = 0;
  for (const request of requests) {
    const result = await agent.buy(request.service, request.input);
    if (result.ok) approved += 1;
    else denied.push({ service: result.service, reason: result.reason });
  }
  return { approved, denied, spent: agent.spent.toString(), budget: agent.policy.spend.maxPerEpoch };
}
