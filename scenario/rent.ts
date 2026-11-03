// Agen penyewa akses harian (AG-028, pipeline P2, ADR-47) dengan format SDK (SD-071): membayar satu hari di depan lewat x402 ke broker, dan hanya menandatangani voucher hari berikutnya bila
// broker mengatakan akses MASIH berjalan (`DailyRent.checkBeforeNextDay`); biaya nyata per hari ditagih dengan voucher terpisah (`signBill`) dan di atas `daily_cap` tidak ditandatangani.
// Kode ini hanya memakai paket publik (`@x207/scheme`, `@x207/core`) dan HTTP ke broker; yang dilakukan kontrak (mendaftarkan voucher) dimainkan oleh pemanggil.
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

  /** Keadaan akses menurut broker, dengan `paidUntil` dalam ms seperti yang dibaca SDK. */
  async view(): Promise<RentView> {
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access`));
    return { ...body, paidUntil: body.paidUntil === null ? 0 : Date.parse(body.paidUntil) };
  }

  /** Tantangan bukti `grantee_ref` (BE-057), atau `null` bila broker tidak memintanya. */
  async challenge(): Promise<{ circle: string; grantId: number; granteeRef: string; nonce: string; challenge: string } | null> {
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access/challenge`));
    return body.required ? body : null;
  }

  /** Satu hari sewa: 402 untuk syaratnya, lalu voucher hari itu di header `PAYMENT-SIGNATURE`. `proof` hanya untuk hari pertama. */
  async payDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String }; proof?: string }): Promise<{ view: RentView; voucher: Voucher }> {
    const url = `${this.#base}/grants/${this.#o.grantId}/access`;
    const body = JSON.stringify({ grantee_ref: this.#o.granteeRef, ...(args.proof ? { proof: args.proof } : {}) });
    const asked = await this.#fetch(url, { method: "POST", body });
    const requirements = (await this.#json(asked)) as { accepts?: Array<{ scheme: string }> };
    const accepted = requirements.accepts?.find((a) => a.scheme === "batch-settlement");
    if (asked.status !== 402 || accepted === undefined) throw new RentError(asked.status, "no_payment_requirements", "broker tidak meminta pembayaran satu hari");
    const voucher = this.daily.signDay({ day: args.day, epoch: args.epoch, state: args.state });
    const { signature, ...unsigned } = voucher;
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { voucher: unsigned, signature } })).toString("base64");
    const paid = await this.#fetch(url, { method: "POST", body, headers: { "PAYMENT-SIGNATURE": header } });
    const answer = await this.#json(paid);
    if (!paid.ok) throw new RentError(paid.status, "payment_not_accepted", JSON.stringify(answer));
    return { view: { ...answer, paidUntil: Date.parse(answer.paidUntil) }, voucher };
  }

  /** Hari berikutnya: dibayar hanya bila broker (dan pemeriksaan langsung ke penyedia, bila ada) mengatakan akses masih berjalan. */
  async payNextDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String }; directCheck?: () => Promise<boolean> }) {
    await this.daily.checkBeforeNextDay(await this.view(), args.directCheck);
    return this.payDay(args);
  }

  /** Penyewa berhenti sewa: notice bertanda tangan ke broker, dan tidak ada voucher lagi. */
  async stop(at: number): Promise<RentView> {
    const notice = { circle: this.#o.circle, grant_id: this.#o.grantId, actor: this.#o.payer, action: "stop", at };
    const text = JSON.stringify(notice);
    const signature = signHash(nep413SigningHash(text, createHash("sha256").update(text, "utf8").digest(), this.#o.circle), this.#o.secretKey as VoucherSecretKey);
    this.daily.stop();
    const body = await this.#json(await this.#fetch(`${this.#base}/grants/${this.#o.grantId}/access/stop`, { method: "POST", body: JSON.stringify({ notice, signature }) }));
    return { ...body, paidUntil: Date.parse(body.paidUntil) };
  }
}
