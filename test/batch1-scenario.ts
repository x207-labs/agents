// Scenario of ten on-chain asset kinds, batch 1 (AG-023, catalog 1 to 10) in the contract: each kind is created from an SDK template (SD-061), offered (`offer_grant`), escrowed,
// bought with a voucher (`complete_escrow`), and checked on the asset side (NFT owner, token balance). Each group (NFT, NEP-141 token, multi-token) also has one invalid
// listing that is rejected, once by the template (SDK error code) and once by the contract (an escrow that does not match the scope). This file is in `test/` because what it sends is
// owner actions (deposit, acceptance), outside the AG-007 agent policy.
import { buildAssetTemplate, signVoucher, AssetTemplateError, type AccountId, type AssetInput, type ContractCall } from "@x207/core";

export type Send = (account: AccountId, call: ContractCall & { gas?: bigint }) => Promise<{ failures: string[]; logs: string[]; value: unknown }>;
export type Batch1World = {
  circle: AccountId;
  grantor: AccountId;
  buyer: AccountId;
  buyerVoucherKey: `ed25519:${string}`;
  epoch: number;
  nft: AccountId;
  /** Mock NEP-141 tokens for kinds ft, rwa and lst. */
  tokens: { ft: AccountId; rwa: AccountId; lst: AccountId };
  mt: AccountId;
  send: Send;
  view: (contractId: AccountId, method: string, args: object) => Promise<unknown>;
};
export type Batch1Step = { kind: string; step: string; ok: boolean; detail: string };

const PRICE = "1000000"; // 1 credit per purchase
export const BATCH1_KINDS = ["nft", "ticket", "game-item", "coupon", "license", "ft", "rwa", "lst", "intents-balance", "pool-share"] as const;

/** `AssetInput` arguments for the ten kinds. `now` in unix seconds. NFTs `t1` to `t5` must already be owned by the grantor. */
export function batch1Inputs(w: Pick<Batch1World, "nft" | "tokens" | "mt">, now: number): Record<(typeof BATCH1_KINDS)[number], AssetInput> {
  const common = { unitPrice: PRICE, expiresAt: now + 6 * 3600 };
  const nft = (tokenId: string) => ({ nftContract: w.nft, tokenId });
  const ft = (contract: AccountId, symbol: string) => ({ ftContract: contract, symbol, decimals: 6, amount: "2500000" });
  return {
    nft: { kind: "nft", name: "Render license", ...nft("t1"), ...common },
    ticket: { kind: "ticket", event: { name: "NEAR Conf", startsAt: now + 86_400, endsAt: now + 2 * 86_400 }, ...nft("t2"), ...common },
    "game-item": { kind: "game-item", game: { name: "Dungeons", collection: "swords" }, ...nft("t3"), ...common },
    coupon: { kind: "coupon", description: "20 percent off", validUntil: now + 30 * 86_400, ...nft("t4"), ...common },
    license: { kind: "license", product: "Editor Pro", termsHash: "ab".repeat(32), seats: 3, ...nft("t5"), ...common },
    ft: { kind: "ft", ...ft(w.tokens.ft, "TKN"), ...common },
    rwa: { kind: "rwa", ...ft(w.tokens.rwa, "RWA"), whitelist: { circleContract: true, grantor: true, buyer: true }, ...common },
    lst: { kind: "lst", ...ft(w.tokens.lst, "LST"), rate: { nearPerToken: "1.0532", source: "pool dashboard", asOf: now }, ...common },
    "intents-balance": { kind: "intents-balance", label: "USDT balance", mtContract: w.mt, tokenId: "nep141:usdt.tether-token.near", amount: "750000", ...common },
    "pool-share": { kind: "pool-share", pool: "NEAR-USDT", valueInfo: "about 12 USDT", standard: "nep245", mtContract: w.mt, tokenId: "pool:1", amount: "42", ...common },
  };
}

export async function runBatch1(w: Batch1World, now: number = Math.floor(Date.now() / 1000)): Promise<Batch1Step[]> {
  const steps: Batch1Step[] = [];
  const note = (kind: string, step: string, ok: boolean, detail: string) => steps.push({ kind, step, ok, detail });
  const inputs = batch1Inputs(w, now);
  let seq = 0;

  const escrowView = (kind: string): string => (["ft", "rwa", "lst"].includes(kind) ? "get_ft_escrow" : ["intents-balance", "pool-share"].includes(kind) ? "get_mt_escrow" : "get_escrow");
  const holder = async (kind: string, input: AssetInput): Promise<string> => {
    if ("tokenId" in input && "nftContract" in input) return String(((await w.view(w.nft, "nft_token", { token_id: input.tokenId })) as { owner_id?: string } | null)?.owner_id);
    if (input.kind === "pool-share" && input.standard === "nep245") return String(await w.view(w.mt, "mt_balance_of", { account_id: w.buyer, token_id: input.tokenId }));
    if (input.kind === "intents-balance") return String(await w.view(w.mt, "mt_balance_of", { account_id: w.buyer, token_id: input.tokenId }));
    if ("ftContract" in input) return String(await w.view(input.ftContract, "ft_balance_of", { account_id: w.buyer }));
    return kind;
  };
  const expectedHolder = (input: AssetInput): string => ("nftContract" in input ? w.buyer : "amount" in input ? String(input.amount) : "");

  for (const kind of BATCH1_KINDS) {
    const input = inputs[kind];
    const t = buildAssetTemplate(input, now);
    const offered = await w.send(w.grantor, { receiverId: w.circle, methodName: "offer_grant", args: { input: t.grantInput }, deposit: 0n });
    const id = Number(offered.value);
    note(kind, "offer_grant", offered.failures.length === 0 && id > 0, offered.failures.join("; ") || `${t.assetType} grant ${id}`);
    if (!(id > 0)) continue;
    const deposited = await w.send(w.grantor, { ...t.deposit(w.circle, id), gas: 150_000_000_000_000n });
    const held = (await w.view(w.circle, escrowView(kind), { grant_id: id })) as { state?: string } | null;
    note(kind, "deposit", deposited.failures.length === 0 && held?.state === "held", `escrow ${held?.state ?? "none"}`);
    seq += 1;
    const { signature, ...voucher } = signVoucher(
      { circle: w.circle, payer: w.buyer, payee: w.grantor, epoch: w.epoch, seq, cumulativeAmount: String(BigInt(PRICE) * BigInt(seq)), unit: "credit", resource: `https://x207.example/grants/${id}` },
      w.buyerVoucherKey,
    );
    const bought = await w.send(w.buyer, { receiverId: w.circle, methodName: "complete_escrow", args: { grant_id: id, voucher, signature }, deposit: 0n, gas: 250_000_000_000_000n });
    const after = (await w.view(w.circle, escrowView(kind), { grant_id: id })) as { state?: string } | null;
    const owns = await holder(kind, input);
    note(kind, "complete_escrow", bought.failures.length === 0 && after?.state === "delivered" && owns === expectedHolder(input), `escrow ${after?.state ?? "none"}, buyer holds ${owns}`);
  }

  // ---- one invalid listing per group: refused by the template (code of the SDK) and by the contract (a deposit that does not match the scope)
  const refusedByTemplate = (input: AssetInput): string => {
    try {
      buildAssetTemplate(input, now);
      return "accepted (wrong)";
    } catch (error) {
      return error instanceof AssetTemplateError ? error.code : `other: ${String(error)}`;
    }
  };
  const ticket = inputs.ticket as Extract<AssetInput, { kind: "ticket" }>;
  const rwa = inputs.rwa as Extract<AssetInput, { kind: "rwa" }>;
  const intents = inputs["intents-balance"] as Extract<AssetInput, { kind: "intents-balance" }>;
  const codes: Array<[string, string, string]> = [
    ["nft-group", refusedByTemplate({ ...ticket, event: { name: "Old", startsAt: now - 2 * 86_400, endsAt: now - 86_400 } }), "ticket_event_over"],
    ["ft-group", refusedByTemplate({ ...rwa, whitelist: { circleContract: false, grantor: true } }), "rwa_not_whitelisted"],
    ["mt-group", refusedByTemplate({ ...intents, tokenId: "usdt" }), "intents_token_id"],
  ];
  for (const [group, got, want] of codes) note(group, "template refuses", got === want, `code ${got}`);

  // contract: offer a fresh grant of each group and deposit something else than the scope names
  const offerOnly = async (input: AssetInput) => {
    const t = buildAssetTemplate(input, now);
    const r = await w.send(w.grantor, { receiverId: w.circle, methodName: "offer_grant", args: { input: t.grantInput }, deposit: 0n });
    return { t, id: Number(r.value) };
  };
  // NFT group: the scope names t1 of the NFT contract, the grantor deposits another NFT (t6)
  {
    const { t, id } = await offerOnly({ kind: "nft", nftContract: w.nft, tokenId: "t1", unitPrice: PRICE, expiresAt: now + 3600 });
    await w.send(w.grantor, { ...t.deposit(w.circle, id), receiverId: w.nft, args: { ...t.deposit(w.circle, id).args, token_id: "t6" }, gas: 150_000_000_000_000n });
    const held = await w.view(w.circle, "get_escrow", { grant_id: id });
    const owner = ((await w.view(w.nft, "nft_token", { token_id: "t6" })) as { owner_id?: string } | null)?.owner_id;
    note("nft-group", "contract refuses a deposit of another NFT", held === null && owner === w.grantor, `escrow ${held === null ? "none" : "held"}, t6 owner ${owner}`);
  }
  // FT group: the scope names 2500000 and the grantor deposits one unit less
  {
    const { t, id } = await offerOnly({ ...(inputs.ft as Extract<AssetInput, { kind: "ft" }>), expiresAt: now + 3600 });
    const before = String(await w.view(w.tokens.ft, "ft_balance_of", { account_id: w.grantor }));
    const call = t.deposit(w.circle, id);
    await w.send(w.grantor, { ...call, args: { ...call.args, amount: "2499999" }, gas: 150_000_000_000_000n });
    const held = await w.view(w.circle, "get_ft_escrow", { grant_id: id });
    const after = String(await w.view(w.tokens.ft, "ft_balance_of", { account_id: w.grantor }));
    note("ft-group", "contract refuses a deposit of another amount", held === null && before === after, `escrow ${held === null ? "none" : "held"}, grantor balance ${before} -> ${after}`);
  }
  // MT group: the scope names 750000 and the grantor deposits 1 unit less
  {
    const { t, id } = await offerOnly({ ...(inputs["intents-balance"] as Extract<AssetInput, { kind: "intents-balance" }>), expiresAt: now + 3600 });
    const before = String(await w.view(w.mt, "mt_balance_of", { account_id: w.grantor, token_id: "nep141:usdt.tether-token.near" }));
    const call = t.deposit(w.circle, id);
    await w.send(w.grantor, { ...call, args: { ...call.args, amount: "749999" }, gas: 150_000_000_000_000n });
    const held = await w.view(w.circle, "get_mt_escrow", { grant_id: id });
    const after = String(await w.view(w.mt, "mt_balance_of", { account_id: w.grantor, token_id: "nep141:usdt.tether-token.near" }));
    note("mt-group", "contract refuses a deposit of another amount", held === null && before === after, `escrow ${held === null ? "none" : "held"}, grantor balance ${before} -> ${after}`);
  }
  return steps;
}
