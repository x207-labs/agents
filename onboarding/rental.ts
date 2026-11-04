// Grantor and renter transactions for the class B scenario (AG-015): `offer_grant` by the grantor and `accept_grant` by the renter, signed by each
// owner's account through the injected `send` (like onboarding). No attached funds: both methods are free. This module is in the onboarding folder because
// the scenario folder must not send transactions (AG-007).
import type { ContractCall } from "@x207/core";
import { CLASS_B_ASSET_TYPE, newAccessKey, type AccessKey } from "../scenario/classb.ts";

/** Sends one contract call from a member's account (grantor or renter) and returns its success value. */
export type SendCall = (call: ContractCall) => Promise<unknown>;

export const CLASS_B_DELIVERY = "near_access_key";

export type OfferRental = {
  /** The grantor account sends `offer_grant`. */
  send: SendCall;
  contract: string;
  scope: string;
  /** Credit smallest units per day. */
  unitPrice: string;
  /** Broker account that hands over the key (`operator` of the grant). */
  operator: string;
  /** Grant deadline, Unix milliseconds. */
  expiresAtMs: number;
};

/** The grantor offers a daily rental; returns `grant_id`. */
export async function offerRental(o: OfferRental): Promise<number> {
  const id = await o.send({
    receiverId: o.contract, methodName: "offer_grant", deposit: 0n,
    args: {
      input: {
        asset_type: CLASS_B_ASSET_TYPE, delivery_method: CLASS_B_DELIVERY,
        limits: { scope: o.scope, quota: null, expires_at: (BigInt(o.expiresAtMs) * 1_000_000n).toString() },
        unit: "day", unit_price: o.unitPrice, operator: o.operator, proof_hash: null, proof_kind: null,
      },
    },
  });
  return Number(id);
}

/** The renter accepts the grant with its own function-call key as `delivery_pubkey`; the secret key stays with the renter. */
export async function acceptRental(o: { send: SendCall; contract: string; grantId: number; key?: AccessKey }): Promise<AccessKey> {
  const key = o.key ?? newAccessKey();
  await o.send({ receiverId: o.contract, methodName: "accept_grant", args: { grant_id: o.grantId, delivery_pubkey: key.publicKey }, deposit: 0n });
  return key;
}

