// `business` scenario (AG-020, K-59): a procurement agent buys services on credit without per-transaction approval, but only within
// the limits the owner sets: a service list (allowlist) with a maximum price per service, a per-call limit, and a budget per epoch.
// The check runs before any payment: the price is read from the seller's 402 challenge, and a new voucher is signed only if
// all limits pass. A purchase outside the limits is rejected with no voucher and no question to a human.
import type { SpendPolicy } from "../shared/identity.ts";

export type ProcurementService = {
  /** Service name in the owner's list, e.g. `translate`. */
  name: string;
  /** Base URL of the selling agent. */
  url: string;
  /** Paid route, e.g. `/api/translate`. */
  path: string;
  /** Maximum price per call for this service, credit smallest unit. */
  maxPrice: string;
};

export type ProcurementPolicy = { spend: SpendPolicy; services: readonly ProcurementService[] };

export type DenialReason =
  | "service_not_allowed"
  | "quote_unavailable"
  | "redirect_refused"
  | "price_above_service_limit"
  | "over_per_call_limit"
  | "over_epoch_budget";

export type Purchase =
  | { ok: true; service: string; price: string; spentThisEpoch: string; status: number; body: unknown }
  | { ok: false; service: string; reason: DenialReason; detail: Record<string, string> };

export type ProcurementOptions = {
  account: string;
  policy: ProcurementPolicy;
  /** `fetch` that pays the 402 with a voucher (createAgentBuyer). */
  pay: typeof fetch;
  /** Plain `fetch` to read the price challenge; defaults to the global `fetch`. */
  quote?: typeof fetch;
};

type Requirement = { scheme?: string; network?: string; amount?: string };

/** x207 price from the 402 challenge: the `batch-settlement` entry on the `x207:` network; `null` if absent or not a 402. */
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
  #tail: Promise<void> = Promise.resolve();
  readonly log: Purchase[] = [];

  constructor(options: ProcurementOptions) {
    this.account = options.account;
    this.policy = options.policy;
    this.#pay = options.pay;
    this.#quote = options.quote ?? fetch;
  }

  /** Spend in the current epoch, credit smallest unit. */
  get spent(): bigint {
    return this.#spent;
  }

  /** New epoch: the budget starts from zero again. */
  newEpoch(): void {
    this.#spent = 0n;
  }

  #deny(service: string, reason: DenialReason, detail: Record<string, string> = {}): Purchase {
    const result: Purchase = { ok: false, service, reason, detail };
    this.log.push(result);
    return result;
  }

  /** Buy one `service` call with `input` if all owner limits pass. */
  buy(service: string, input: string): Promise<Purchase> {
    // A-AG-11: one purchase at a time, so the budget check and the spent counter see each other (concurrent calls could all pass the check and overshoot the epoch budget)
    const run = this.#tail.then(() => this.#buy(service, input));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #buy(service: string, input: string): Promise<Purchase> {
    const listed = this.policy.services.find((s) => s.name === service);
    if (!listed) return this.#deny(service, "service_not_allowed");
    const target = `${listed.url}${listed.path}?input=${encodeURIComponent(input)}`;

    // no redirect is followed: the payment header would go to the target of the redirect (A-AG-11)
    const quoted = await this.#quote(target, { redirect: "manual" });
    if (quoted.status >= 300 && quoted.status < 400) return this.#deny(service, "redirect_refused", { status: String(quoted.status), step: "quote" });
    const price = await readQuote(quoted);
    if (price === null) return this.#deny(service, "quote_unavailable");
    const amount = BigInt(price);
    if (amount > BigInt(listed.maxPrice)) return this.#deny(service, "price_above_service_limit", { price, limit: listed.maxPrice });
    if (amount > BigInt(this.policy.spend.maxPerCall)) return this.#deny(service, "over_per_call_limit", { price, limit: this.policy.spend.maxPerCall });
    if (this.#spent + amount > BigInt(this.policy.spend.maxPerEpoch)) {
      return this.#deny(service, "over_epoch_budget", { price, spent: this.#spent.toString(), limit: this.policy.spend.maxPerEpoch });
    }

    const response = await this.#pay(target, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) return this.#deny(service, "redirect_refused", { status: String(response.status), step: "pay" });
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

/** Run a list of purchases in sequence without human confirmation and summarize the result. */
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
