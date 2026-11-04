// Daily access renter agent (AG-028, pipeline P2, ADR-47) in the SDK format (SD-071): pays one day ahead through x402 to the broker, and only signs the next day's voucher if
// the broker says the access is STILL running (`DailyRent.checkBeforeNextDay`); the real cost per day is billed with a separate voucher (`signBill`) and is not signed above `daily_cap`.
// This code only uses the public packages (`@x207/scheme`, `@x207/core`) and HTTP to the broker; what the contract does (registering vouchers) is played by the caller.
import { createHash } from "node:crypto";
import { nep413SigningHash, signHash, type AccessView, type U128String, type Voucher, type VoucherSecretKey } from "@x207/core";
import { DailyRent, type DailyRentOptions } from "@x207/scheme";

export type RentView = AccessView & { provider: string; granteeRef: string; proof: string | null; reason: string | null; delivery?: Record<string, unknown>; warnings?: string[]; today?: { day: number | string; cost: string | null; billed: string | null } }
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class RentError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.name = "RentBrokerError";
    this.status = status;
    this.code = code;
  }
}

export class RentLessee {
  readonly daily: DailyRent;
  readonly #base: string;
  readonly #fetch: Fetch;
  readonly #o: DailyRentOptions & { granteeRef: string };

  constructor(base: string, fetchFn: Fetch, options: DailyRentOptions & { granteeRef: string }) {
    this.#base = base;
    this.#fetch = fetchFn;
    this.#o = options;
    this.daily = new DailyRent(options);
  }

  async #json(res: Response): Promise<any> {
    const body: any = await res.json().catch(() => null);
    if (!res.ok && res.status !== 402) throw new RentError(res.status, body?.error ?? "http_error", body?.message ?? "");
    return body;
  }

  /** Access state according to the broker, with `paidUntil` in ms as the SDK reads it. */
  async view(): Promise<RentView> {
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access`));
    return { ...body, paidUntil: body.paidUntil === null ? 0 : Date.parse(body.paidUntil) };
  }

  /** The `grantee_ref` proof challenge (BE-057), or `null` if the broker does not request it. */
  async challenge(): Promise<{ circle: string; grantId: number; granteeRef: string; nonce: string; challenge: string } | null> {
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access/challenge`));
    return body.required ? body : null;
  }

  /** One rental day: a 402 for its terms, then that day's voucher in the `PAYMENT-SIGNATURE` header. `proof` only for the first day. */
  async payDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String }; proof?: string }): Promise<{ view: RentView; voucher: Voucher }> {
    const url = `${this.#base}/grants/${this.#o.grantId}/access`;
    const body = JSON.stringify({ grantee_ref: this.#o.granteeRef, ...(args.proof ? { proof: args.proof } : {}) });
    const asked = await this.#fetch(url, { method: "POST", body });
    const requirements = (await this.#json(asked)) as { accepts?: Array<{ scheme: string }> };
    const accepted = requirements.accepts?.find((a) => a.scheme === "batch-settlement");
    if (asked.status !== 402 || accepted === undefined) throw new RentError(asked.status, "no_payment_requirements", "the broker did not ask for a one-day payment");
    const voucher = this.daily.signDay({ day: args.day, epoch: args.epoch, state: args.state });
    const { signature, ...unsigned } = voucher;
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { voucher: unsigned, signature } })).toString("base64");
    const paid = await this.#fetch(url, { method: "POST", body, headers: { "PAYMENT-SIGNATURE": header } });
    const answer = await this.#json(paid);
    if (!paid.ok) throw new RentError(paid.status, "payment_not_accepted", JSON.stringify(answer));
    return { view: { ...answer, paidUntil: Date.parse(answer.paidUntil) }, voucher };
  }

  /** Next day: paid only if the broker (and a direct check with the provider, if any) says the access is still running. */
  async payNextDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String }; directCheck?: () => Promise<boolean> }) {
    await this.daily.checkBeforeNextDay(await this.view(), args.directCheck);
    return this.payDay(args);
  }

  /** The renter stops renting: a signed notice to the broker, and no more vouchers. */
  async stop(at: number): Promise<RentView> {
    const notice = { circle: this.#o.circle, grant_id: this.#o.grantId, actor: this.#o.payer, action: "stop", at };
    const text = JSON.stringify(notice);
    const signature = signHash(nep413SigningHash(text, createHash("sha256").update(text, "utf8").digest(), this.#o.circle), this.#o.secretKey as VoucherSecretKey);
    this.daily.stop();
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access/stop`, { method: "POST", body: JSON.stringify({ notice, signature }) }));
    return { ...body, paidUntil: Date.parse(body.paidUntil) };
  }
}
