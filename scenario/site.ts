// Agents that sell and buy a website or an online shop (#67, pipeline P4, UM-098). x207 does not move a site: the seller hands over the two things that make it the buyer's with the official
// features outside x207, and x207 only decides when the buyer's vouchers are paid. A site is TWO sales, each with its own proof, because the ledger of the backend keeps refusing the asset type
// `site:web-property` as one listing (`asset_roadmap_only`):
//   1. the domain, through the transfer ledger (BE-074, AG-031): the voucher is held until the registrar shows the domain moved (`x207-own` TXT and RDAP);
//   2. the admin credentials, once, through `secret_release` (the one-time code flow of AG-030, BE-069): sealed to the buyer, who takes control of the panel (log in and change the password) and
//      only then confirms. The credentials are code-like: no issuer can check them, so the value is capped at 20 credit.
// The ORDER is the rule, and the vouchers are cumulative: the credentials are handed over only after the domain is proven (the seller side, `handOverCredentials`), and the buyer confirms them
// only after it took control (`takeOverSite`). The voucher of the credentials is the later one of the pair, so it carries the price of the domain too: it is never released before the domain's.
import type { ContentRef, ContentSource, VoucherSecretKey } from "@x207/core";
import { signJsonNotice } from "./invoice-book.ts";
import { buyCode, listCode, receiveCode, serveCode, type CodeActor, type CodeBookApi, type CodePurchase, type ReceivedCode, type SoldCode } from "./code.ts";
import { buyTransfer, prepareTransfer, type HttpTransferBook, type PairState, type PreparedTransfer, type TransferActor, type TransferState } from "./transfer.ts";

export type SiteSale = { domain: PreparedTransfer; credentials: SoldCode };
export type SitePurchase = { transfer: TransferState; credentials: CodePurchase };

/** The seller prepares the two listings. The domain listing is returned unposted: the seller sets `x207-sell=<listing hash>` on the domain first, then posts it (`postTransfer`). */
export async function prepareSite(
  transfers: HttpTransferBook, codes: CodeBookApi, seller: CodeActor,
  o: { domain: string; domainPrice: string; credentials: string; credentialsPrice: string; nonce: string; expiresAt: number },
): Promise<SiteSale> {
  const domain = prepareTransfer(transfers, seller as TransferActor, { platform: "domain", ref: o.domain, price: o.domainPrice, estimateSeconds: 3600, nonce: `${o.nonce}-domain`, expiresAt: o.expiresAt });
  const credentials = await listCode(codes, seller, { code: o.credentials, issuer: "site-admin", verifiable: false, price: o.credentialsPrice, nonce: `${o.nonce}-admin`, expiresAt: o.expiresAt, assetType: "secret:site-admin" });
  return { domain, credentials };
}

/** The buyer pays both: the domain first (voucher 1), the credentials second (voucher 2, which continues the pair). Both are held by the backend. */
export async function buySite(
  transfers: HttpTransferBook, codes: CodeBookApi, buyer: CodeActor, sale: SiteSale, epoch: number, pair: PairState,
): Promise<SitePurchase> {
  const transfer = await buyTransfer(transfers, buyer as TransferActor, sale.domain, epoch, pair);
  const credentials = await buyCode(codes, buyer, sale.credentials, epoch, pair);
  pair.seq += 1;
  pair.cumulative = (BigInt(pair.cumulative) + BigInt(sale.credentials.listing.offer.value)).toString();
  return { transfer, credentials };
}

export class SiteError extends Error {
  readonly code: "domain_not_proven";
  constructor(code: "domain_not_proven", message: string) {
    super(message);
    this.name = "SiteError";
    this.code = code;
  }
}

/** The seller hands over the credentials only when the domain has moved (the transfer is `confirmed`). Before that the key stays with the seller and nothing is exposed. */
export async function handOverCredentials(
  transfers: HttpTransferBook, codes: CodeBookApi, seller: CodeActor, sale: SiteSale, bought: SitePurchase, source: ContentRef, buyer: CodeActor,
): Promise<CodePurchase> {
  const transfer = await transfers.getTransfer(bought.transfer.transferId);
  if (transfer.status !== "confirmed") throw new SiteError("domain_not_proven", `the domain transfer is ${transfer.status}: the credentials stay with the seller`);
  return serveCode(codes, seller, bought.credentials.purchaseId, sale.credentials, source, buyer);
}

/**
 * The buyer opens the credentials and takes control of the panel (`takeControl` logs in and changes the password; it returns false when the credentials do not work). Only then the
 * purchase is confirmed and the voucher can go to the seller. A buyer that cannot take control confirms nothing.
 */
export function takeOverSite(
  codes: CodeBookApi, buyer: CodeActor, bought: SitePurchase, sale: SiteSale, sellerPublicKey: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>,
  takeControl: (credentials: string) => Promise<boolean>,
): Promise<ReceivedCode> {
  return receiveCode(codes, buyer, bought.credentials.purchaseId, sellerPublicKey, sources, { doc: sale.credentials.doc, redeem: takeControl });
}

/** The seller (or the buyer after the window) gives up a credentials sale that was never handed over: nothing is paid. */
export function cancelCredentials(codes: CodeBookApi, actor: { account: string; secretKey: VoucherSecretKey }, id: string): Promise<CodePurchase> {
  const notice = { circle: codes.contract, purchase_id: id, actor: actor.account, action: "cancelled", at: codes.at(), reason: null, proof: null };
  return codes.notice(id, notice, signJsonNotice(codes.contract, notice, actor.secretKey));
}
