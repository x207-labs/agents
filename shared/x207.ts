// Binding x207 untuk agent (AG-005): penjual lewat x207Middleware, pembeli lewat @x402/fetch dengan klien x207.
// Hanya paket publik @x402/fetch, @x207/scheme, dan @x207/core yang dipakai di sini (AG-006).
import { wrapFetchWithPayment } from "@x402/fetch";
import { X207PaymentClient, headroomFromRpc, x207Middleware } from "@x207/scheme";
import type { Paywall, SellerConfig } from "./agent-server.ts";
import type { AgentIdentity } from "./identity.ts";
import type { AgentSpec } from "./registry.ts";

/** Harga default per panggilan: 0,02 credit (FX-04). */
export const DEFAULT_PRICE = "$0.02";

/** Endpoint berbayar `/api/<verb>` dengan `accepts` x207 dan `exact`; header PAYMENT-RESPONSE diteruskan oleh middleware. */
export function createSellerPaywall(spec: AgentSpec, config: SellerConfig): Paywall {
  return x207Middleware({
    routes: { [`/api/${spec.verb}`]: { price: config.price ?? DEFAULT_PRICE, description: `${spec.name} agent` } },
    facilitatorUrl: config.facilitatorUrl,
    circleId: config.circleId,
    payTo: config.payTo,
  });
}

export type BuyerOptions = {
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
};

/** `fetch` yang membayar 402 dengan voucher bertanda tangan kunci voucher agent; tidak pernah mengirim transaksi. */
export function createAgentBuyer(identity: AgentIdentity, options: BuyerOptions = {}): typeof fetch {
  const client = new X207PaymentClient({
    payer: identity.accountId,
    secretKey: identity.voucherSecretKey,
    headroom: headroomFromRpc({
      ...(options.rpcUrls ? { rpcUrls: options.rpcUrls } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  return wrapFetchWithPayment(options.fetch ?? fetch, client);
}
