// AG-051: client of the x207 appraiser (backend BE-119, `POST /x207/appraise`). A model on NEAR AI Cloud (private inference in a TEE)
// values one asset with a fixed rubric; the backend keeps the TEE signature and an attestation summary. The agent uses the answer as
// advice for its asking price and names the appraisal in the listing `detail` (`appraisal=apr_...`), the off-chain metadata of the offer.
// The circle contract does not read it, and the other party still agrees on the price.
import type { AssetClass } from "@x207/core";

/** The asset as the appraiser reads it (backend `assetOf`). */
export type AppraisalAsset = {
  asset_type: string;
  asset_class: AssetClass;
  quantity: number;
  scope: string;
  provider: string;
  duration_days?: number | null;
  /** Credit (1 credit settles as 1 USDT), decimal string with at most 6 decimals. */
  market_price_credits?: string | null;
  description?: string;
};

export type Appraisal = {
  appraisal_id: string;
  model: string;
  cached: boolean;
  result: { value_credits: string; range: { low: string; high: string }; confidence: number; rationale: string; flags: string[] };
  verified: { signature: boolean; attestation: "checked" | "not_checked" | "failed" };
};

export class AppraiserError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppraiserError";
    this.status = status;
    this.code = code;
  }
}

export type AppraiserOptions = { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number };

export class AppraiserClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: AppraiserOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 90_000;
  }

  async appraise(asset: AppraisalAsset): Promise<Appraisal> {
    const res = await this.#fetch(`${this.#base}/x207/appraise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(asset),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as (Appraisal & { error?: { code: string; message: string } }) | null;
    if (!res.ok || !body || body.error) throw new AppraiserError(res.status, body?.error?.code ?? "appraiser_error", body?.error?.message ?? `appraiser answered HTTP ${res.status}`);
    return body;
  }
}

const UNIT = 1_000_000n; // credit has 6 decimals

/** Credit decimal string -> smallest units. */
export function creditUnits(credits: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(credits);
  if (!m) throw new Error(`not a credit amount: ${credits}`);
  return BigInt(m[1]!) * UNIT + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Smallest units -> credit decimal string (for `market_price_credits`). */
export function creditsOf(units: bigint): string {
  const frac = (units % UNIT).toString().padStart(6, "0").replace(/0+$/, "");
  return `${units / UNIT}${frac ? `.${frac}` : ""}`;
}

/**
 * The asking total of a listing from an appraisal: the appraised value, kept within `maxDeviationBps` of the owner's own total
 * (default 50 %), so a wrong or manipulated answer cannot move the price far from what the owner set. Only an appraisal whose
 * signature x207 checked is used; otherwise the owner's total stays.
 */
export function askingTotal(ownerTotal: bigint, appraisal: Appraisal, maxDeviationBps = 5000): { total: bigint; used: boolean } {
  if (!appraisal.verified.signature) return { total: ownerTotal, used: false };
  const appraised = creditUnits(appraisal.result.value_credits);
  const low = (ownerTotal * BigInt(10_000 - maxDeviationBps)) / 10_000n;
  const high = (ownerTotal * BigInt(10_000 + maxDeviationBps)) / 10_000n;
  const total = appraised < low ? low : appraised > high ? high : appraised;
  return { total: total > 0n ? total : ownerTotal, used: true };
}

/** `detail` of a listing with the appraisal named (ASCII, at most 2048 characters, like the book requires). */
export function detailWithAppraisal(detail: string, appraisalId: string): string {
  if (!/^apr_[0-9a-f]{24}$/.test(appraisalId)) throw new Error(`not an appraisal id: ${appraisalId}`);
  const tag = `appraisal=${appraisalId}`;
  const room = 2048 - tag.length - 3;
  return `${detail.slice(0, Math.max(0, room))} | ${tag}`;
}
