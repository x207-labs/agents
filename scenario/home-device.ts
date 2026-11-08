// `home-device` scenario (AG-049, pipeline P5, kind #90 `compute:home-device`): the owner of an idle home computer sells it by the minute and by the day, and the device can
// go offline at any time (power, network, the family switches it off). That is the risk of this kind, so the buyer prepays one slice of minutes at a time at the price the
// endpoint announces, and stops paying when a slice is not delivered: the loss is at most that one slice. A day lease is one voucher. Only the existing vouchers; no new
// contract and no network (the device is a mock; a real provider would run behind the same endpoint).
import { signVoucher, verifyVoucher, voucherPublicKey, type Voucher, type VoucherSecretKey } from "@x207/core";
import { createMeteredEndpoint, resolvePrice } from "@x207/scheme";

export const SLICE_MINUTES = 30;
export const SLICES = 4;

/** A home computer that is on for the first `onlineMinutes` minutes of the rental and then goes offline. */
export class MockHomeDevice {
  #delivered = 0;
  readonly onlineMinutes: number;
  constructor(onlineMinutes: number) {
    this.onlineMinutes = onlineMinutes;
  }
  /** The device works for `minutes` more minutes; returns what it really delivered (less than asked once it is offline). */
  run(minutes: number): number {
    const done = Math.max(0, Math.min(minutes, this.onlineMinutes - this.#delivered));
    this.#delivered += done;
    return done;
  }
  get deliveredMinutes(): number {
    return this.#delivered;
  }
}

export type HomeDeviceOutcome = {
  warnings: readonly string[];
  /** Minutes the buyer paid for and minutes the device delivered. */
  minutesPaid: number;
  minutesDelivered: number;
  slicesPaid: number;
  /** Price of the minutes that were delivered, of the minutes that were paid, and what the buyer lost (paid and not delivered). */
  earned: string;
  paid: string;
  buyerLoss: string;
  dayLease: { unit: string; paid: string };
  /** A request above the ceiling of the unit is refused before any voucher. */
  overCeilingRefused: boolean;
  vouchers: Voucher[];
  cumulative: string;
  seq: number;
};

export async function runHomeDeviceScenario(args: { circle: string; epoch: number; buyer: string; owner: string; buyerKey: VoucherSecretKey; device: MockHomeDevice }): Promise<HomeDeviceOutcome> {
  const { circle, epoch, buyer, owner, buyerKey, device } = args;
  const vouchers: Voucher[] = [];
  let cumulative = 0n;
  let seq = 0;
  const pay = (resource: string, amount: bigint): void => {
    cumulative += amount;
    seq += 1;
    vouchers.push(signVoucher({ circle, payer: buyer, payee: owner, epoch, seq, cumulativeAmount: cumulative.toString(), unit: "credit", resource }, buyerKey));
  };
  const ask = (endpoint: ReturnType<typeof createMeteredEndpoint>, quantity: number): Promise<{ amount: string }> =>
    resolvePrice(endpoint.route.price, new Request(`https://home.example/api/device?quantity=${quantity}`), endpoint.route.maxQuantity);

  // 1. minutes: prepay a slice at the announced price, then the device works; stop paying after the first slice that is not delivered
  const minutes = createMeteredEndpoint({ kind: "home-device", unit: "minute", unitPrice: "$0.01", handler: () => new Response("done") });
  const slicePrice = BigInt((await ask(minutes, SLICE_MINUTES)).amount);
  let slicesPaid = 0;
  let minutesPaid = 0;
  let earnedAmount = 0n;
  for (let slice = 1; slice <= SLICES; slice++) {
    pay(`device:${minutes.assetType}:slice-${slice}`, slicePrice);
    slicesPaid += 1;
    minutesPaid += SLICE_MINUTES;
    const delivered = device.run(SLICE_MINUTES);
    earnedAmount += (slicePrice * BigInt(delivered)) / BigInt(SLICE_MINUTES);
    if (delivered < SLICE_MINUTES) break; // the device went offline inside this slice: no further slice is paid
  }
  const paidForMinutes = cumulative;

  // 2. one day lease: one voucher at the price of the day unit
  const days = createMeteredEndpoint({ kind: "home-device", unit: "day", unitPrice: "$1", handler: () => new Response("leased") });
  const dayAmount = BigInt((await ask(days, 1)).amount);
  pay(`device:${days.assetType}:day`, dayAmount);

  // 3. a request above the ceiling of the unit (1440 minutes per request) is refused before any voucher is signed
  let overCeilingRefused = false;
  try {
    await ask(minutes, 1441);
  } catch {
    overCeilingRefused = true;
  }

  return {
    warnings: minutes.warnings, minutesPaid, minutesDelivered: device.deliveredMinutes, slicesPaid,
    earned: earnedAmount.toString(), paid: paidForMinutes.toString(), buyerLoss: (paidForMinutes - earnedAmount).toString(),
    dayLease: { unit: days.unit, paid: dayAmount.toString() }, overCeilingRefused, vouchers, cumulative: cumulative.toString(), seq,
  };
}

/** Vouchers valid under the buyer key, and a cumulative series that rises with no gaps. */
export function verifyHomeDeviceOutcome(outcome: HomeDeviceOutcome, buyer: string, buyerKey: VoucherSecretKey): boolean {
  const publicKey = voucherPublicKey(buyerKey);
  let last = 0n;
  let seq = 0;
  for (const v of outcome.vouchers) {
    if (v.payer !== buyer || !verifyVoucher(v, publicKey) || v.seq !== seq + 1 || BigInt(v.cumulativeAmount) <= last) return false;
    last = BigInt(v.cumulativeAmount);
    seq = v.seq;
  }
  return last.toString() === outcome.cumulative && seq === outcome.seq;
}
