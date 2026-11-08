// x207 binding for agents (AG-005): the seller through x207Middleware, the buyer through @x402/fetch with the x207 client.
// Only the public packages @x402/fetch, @x207/scheme, and @x207/core are used here (AG-006).
import { wrapFetchWithPayment } from "@x402/fetch";
import { X207ExtraSource, X207PaymentClient, headroomFromRpc, x207Middleware } from "@x207/scheme";
import type { Paywall, SellerConfig } from "./agent-server.ts";
import type { AgentIdentity } from "./identity.ts";
import type { AgentSpec } from "./registry.ts";

/** Default price per call: 0.02 credit (FX-04). */
export const DEFAULT_PRICE = "$0.02";

/** Paid endpoint `/api/<verb>` with x207 `accepts` and `exact`; the PAYMENT-RESPONSE header is passed through by the middleware. */
export function createSellerPaywall(spec: AgentSpec, config: SellerConfig): Paywall {
  return x207Middleware({
    routes: { [`/api/${spec.verb}`]: { price: config.price ?? DEFAULT_PRICE, description: `${spec.name} agent` } },
    facilitatorUrl: config.facilitatorUrl,
    circleId: config.circleId,
    payTo: config.payTo,
    ...(config.now ? { extra: new X207ExtraSource({ facilitatorUrl: config.facilitatorUrl, now: config.now }) } : {}),
  });
}

export type BuyerOptions = {
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** F5 bundle leg (SD-048): `bundle_id` for payment to `payee` in `epoch`, or `undefined` if not a leg. */
  bundleFor?: (payee: string, epoch: number) => number | undefined;
  /** A-AG-08/09: what the 402 of a seller may name (circles, payees, the open epoch); without it the buyer follows the seller. See `X207ClientOptions.accept`. */
  accept?: { circles?: readonly string[]; payees?: readonly string[]; currentEpoch?: () => Promise<number | null> };
};

/** `fetch` that pays the 402 with a voucher signed by the agent voucher key; never sends a transaction. */
export function createAgentBuyer(identity: AgentIdentity, options: BuyerOptions = {}): typeof fetch {
  const client = new X207PaymentClient({
    payer: identity.accountId,
    secretKey: identity.voucherSecretKey,
    // AG-008: the owner spend policy becomes the client guard; a voucher above the limit is never signed
    spendLimit: { maxPerCall: identity.policy.maxPerCall, maxPerEpoch: identity.policy.maxPerEpoch },
    ...(options.bundleFor ? { bundleFor: options.bundleFor } : {}),
    ...(options.accept ? { accept: options.accept } : {}),
    headroom: headroomFromRpc({
      ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  return wrapFetchWithPayment(options.fetch ?? fetch, client);
}
