import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, METERED_PRESETS } from "@x207/core";
import { MockHomeDevice, SLICES, SLICE_MINUTES, runHomeDeviceScenario, verifyHomeDeviceOutcome } from "../scenario/home-device.ts";

const BUYER = "buyer.x207-circle.near";
const OWNER = "home.x207-circle.near";
const key = generateVoucherKeypair();
const run = (onlineMinutes: number) =>
  runHomeDeviceScenario({ circle: "x207-circle.near", epoch: 42, buyer: BUYER, owner: OWNER, buyerKey: key.secretKey, device: new MockHomeDevice(onlineMinutes) });

describe("AG-049 home device (P5, kind #90 compute:home-device)", () => {
  it("TC-AG-049-01 a device that stays on: every slice is paid at the announced minute price and delivered, nothing is lost", async () => {
    const o = await run(SLICES * SLICE_MINUTES);
    expect(o).toMatchObject({ slicesPaid: SLICES, minutesPaid: 120, minutesDelivered: 120, paid: "1200000", earned: "1200000", buyerLoss: "0" });
    expect(o.dayLease).toEqual({ unit: "day", paid: "1000000" });
  });

  it("TC-AG-049-02 a device that goes offline inside a slice: the buyer stops paying and loses at most the part of that one slice", async () => {
    const o = await run(SLICE_MINUTES + 10); // on for one slice and 10 minutes of the second
    expect(o).toMatchObject({ slicesPaid: 2, minutesPaid: 60, minutesDelivered: 40 });
    expect(BigInt(o.buyerLoss)).toBe(BigInt(o.paid) - BigInt(o.earned));
    expect(BigInt(o.buyerLoss)).toBeLessThanOrEqual(300_000n); // never more than one slice (30 minutes at 0.01)
    expect(o.buyerLoss).toBe("200000");
    const dead = await run(0); // never delivers: the loss is the first slice only
    expect(dead).toMatchObject({ slicesPaid: 1, minutesDelivered: 0, buyerLoss: "300000" });
  });

  it("TC-AG-049-03 the listing warning names electricity and security; a request above the ceiling is refused; the vouchers are one valid series", async () => {
    const o = await run(60);
    expect(o.warnings.join(" ")).toMatch(/Electricity, network security, and hardware are borne by the owner/);
    expect(o.warnings).toEqual(METERED_PRESETS["home-device"].warnings);
    expect(o.overCeilingRefused).toBe(true);
    expect(verifyHomeDeviceOutcome(o, BUYER, key.secretKey)).toBe(true);
    expect(o.seq).toBe(o.slicesPaid + 1); // the slices and the day lease
    const forged = { ...o, vouchers: o.vouchers.map((v, i) => (i === 0 ? { ...v, cumulativeAmount: "1" } : v)) };
    expect(verifyHomeDeviceOutcome(forged, BUYER, key.secretKey)).toBe(false);
  });
});
