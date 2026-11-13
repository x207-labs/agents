# AG-052: three-agent barter ring on testnet v018

Date: 2026-11-12. Contract `x207-v018.testnet`, circle `agents-main`, settlement token `usdt.x207-deployer.testnet` (mock USDT). Script: [`scripts/demo-barter-cycle.ts`](../scripts/demo-barter-cycle.ts). Full evidence: [`demo-barter-cycle.json`](demo-barter-cycle.json) (epoch 184).

## What it shows

Three member agents each hold a different digital asset. Each asset is valued by the live appraiser, and the three trades form one ring: alice → bob → dan2 → alice. The trades are paid in credit, not cash. At the end of the epoch, clearing cancels the loop, and only the net difference moves as USDT.

## Who ran it

One script, run by one operator, played all three members. Each member has its own NEAR account, its own access key and its own voucher key, and the script signs each member's part with that member's keys only:

- **Voucher keys.** The bundle carries one signature per member, and each `register_in_bundle` carries the payer's voucher signature, made with that payer's voucher key.
- **Transactions.** The permissionless calls are sent by one member acting as relayer: the one with the most NEAR, which was dan2. So dan2 signed the transactions of `commit_bundle`, the three `register_in_bundle`, `close_epoch`, `submit_clearing`, `commit_epoch`, `finalize_epoch` and its own claim. alice signed her USDT payment (`ft_transfer_call`), and bob signed his claim.

This shows the contract's rules on real accounts and keys. It does not show three independent operators agreeing on a trade.

## Assets and appraisals

Each value comes from `POST https://v018.x207.boxd.sh/x207/appraise`. Each appraisal's signature was verified and its attestation was checked.

| Holder | Asset (catalog no.) | Class | Market price | Appraised value | Range | `appraisal_id` |
|---|---|---|---|---|---|---|
| alice | `maps:geocoding-quota`: 4 × 10000 Mapbox geocoding calls, 30 days (64) | C | 30 | **24** | 20–28 | [`apr_4d97a431de9635c442083c67`](https://v018.x207.boxd.sh/x207/appraisals/apr_4d97a431de9635c442083c67) |
| bob | `license:software-nft`: one 12-month JetBrains seat as an NFT (5) | A | 32 | **32** | 30–34 | [`apr_d2e83a701cbcbed1309a46fa`](https://v018.x207.boxd.sh/x207/appraisals/apr_d2e83a701cbcbed1309a46fa) |
| dan2 | `near-rpc:access`: function-call key to a FastNEAR premium RPC account, 30 days (15) | B | 28 | **25** | 20–30 | [`apr_062aca549faa3b4be3affaaf`](https://v018.x207.boxd.sh/x207/appraisals/apr_062aca549faa3b4be3affaaf) |

Values are in credit; 1 credit = 1 mock USDT. The appraiser model is `Qwen/Qwen3.6-35B-A3B-FP8`. The epoch 184 run reused the cached appraisals from the first run, so both runs carry the same ids.

## The ring (epoch 184)

All three members sign one bundle (`commit_bundle`, bundle id 2). Each payer then registers a voucher for its leg (`register_in_bundle`). Each payer pays the appraised value of the asset it receives.

| Leg | Payer takes | Gross | Cancelled by clearing | Residue |
|---|---|---|---|---|
| alice → bob | bob's license | 32 | 24 | 8 |
| bob → dan2 | dan2's RPC access | 25 | 24 | 1 |
| dan2 → alice | alice's geocoding quota | 24 | 24 | 0 |
| **Total** | | **81** | **72 (88.9%)** | **9** |

The ring cancels 24 credit on every leg, the value of its smallest leg. The values are not exactly equal, so a small residue is left.

| Member | Net position | Settlement |
|---|---|---|
| alice | −8 | pays 8 USDT ([settle tx](https://testnet.nearblocks.io/txns/5gd31nuATR78nXTaJ476CWC2HAg9UK51aGK31diXSsb5)) |
| bob | +7 | claims 7 ([claim tx](https://testnet.nearblocks.io/txns/9LhQ5hrQn92cy3X4ikqEWLxn3AcTDtnXtGZPaH7Y4NK)) |
| dan2 | +1 | claims 1 ([claim tx](https://testnet.nearblocks.io/txns/3b6L485sPSWuWVLW3ojf1PppRTEHDdU27R4z6coqcL5L)) |

The value that moves drops from **81 to 8 USDT**, 9.9% of gross. The number of transfers does not drop: one payment in (alice, 8) and two claims out (bob 7, dan2 1) take the place of three trade payments. The leg residues add up to 9, but bob has 1 in and 8 out, so the net is what moves. No other voucher was registered in epoch 184 (`other_obligations_in_epoch` is empty). The epoch holds the ring only.

## Transactions (epoch 184)

| Step | Transaction |
|---|---|
| commit_bundle (all three signatures) | [`3sTW11uEqDFa3Zzs1qkTSrDFmShmLgqMrHAhTqB3fjpm`](https://testnet.nearblocks.io/txns/3sTW11uEqDFa3Zzs1qkTSrDFmShmLgqMrHAhTqB3fjpm) |
| register_in_bundle alice → bob (32) | [`EHDroH4kZfrLz9kxhSdQKVw79wLrEzXxFkkgvZhYHHWL`](https://testnet.nearblocks.io/txns/EHDroH4kZfrLz9kxhSdQKVw79wLrEzXxFkkgvZhYHHWL) |
| register_in_bundle bob → dan2 (25) | [`C2qaA1uVh1SXRtV1xSX3y1sBgF5TUHtB64BouEvmtAdF`](https://testnet.nearblocks.io/txns/C2qaA1uVh1SXRtV1xSX3y1sBgF5TUHtB64BouEvmtAdF) |
| register_in_bundle dan2 → alice (24) | [`Fgcw5nLCx3Qo4q6EY5Y5aYoCsiiTFuN52YEwJWSGMw5j`](https://testnet.nearblocks.io/txns/Fgcw5nLCx3Qo4q6EY5Y5aYoCsiiTFuN52YEwJWSGMw5j) |
| close_epoch 184 | [`9tpdyXRQnfSKtmBUzfiFqfkczyygf4LJMhP7hA3hYFZL`](https://testnet.nearblocks.io/txns/9tpdyXRQnfSKtmBUzfiFqfkczyygf4LJMhP7hA3hYFZL) |
| submit_clearing 184 (3 edges, 72 cleared) | [`AAUVpLjAY2TrcJNDjVSyimXUDififQdttiX7oceQHvFc`](https://testnet.nearblocks.io/txns/AAUVpLjAY2TrcJNDjVSyimXUDififQdttiX7oceQHvFc) |
| commit_epoch 184 | [`FvH715MXWp9QhRoj9vJXhiZoV4sdtK2nuz4S1dSPjH8J`](https://testnet.nearblocks.io/txns/FvH715MXWp9QhRoj9vJXhiZoV4sdtK2nuz4S1dSPjH8J) |
| settle: alice pays 8 USDT | [`5gd31nuATR78nXTaJ476CWC2HAg9UK51aGK31diXSsb5`](https://testnet.nearblocks.io/txns/5gd31nuATR78nXTaJ476CWC2HAg9UK51aGK31diXSsb5) |
| finalize_epoch 184 | [`BUEZd5jHuFjHkrTddVXCpk9EJPMhZcYgpCeWVkJ9TDHf`](https://testnet.nearblocks.io/txns/BUEZd5jHuFjHkrTddVXCpk9EJPMhZcYgpCeWVkJ9TDHf) |
| claim bob (7) | [`9LhQ5hrQn92cy3X4ikqEWLxn3AcTDtnXtGZPaH7Y4NK`](https://testnet.nearblocks.io/txns/9LhQ5hrQn92cy3X4ikqEWLxn3AcTDtnXtGZPaH7Y4NK) |
| claim dan2 (1) | [`3b6L485sPSWuWVLW3ojf1PppRTEHDdU27R4z6coqcL5L`](https://testnet.nearblocks.io/txns/3b6L485sPSWuWVLW3ojf1PppRTEHDdU27R4z6coqcL5L) |

Run time: 17:18 to 18:02 UTC. Most of it is the epoch schedule: the 1800 s epoch, a 60 s proposal window and a 900 s payment window.

## Links

- Dashboard, epoch 184: https://x207.vercel.app/stats?epoch=184&circle=v018
- Epoch metrics (API): https://v018.x207.boxd.sh/x207/circles/agents-main/epochs/184/metrics (`cleared` 72000000, `clearedRatio` 0.8889, `netDebt` 8000000)
- Bundles of the circle (API): https://v018.x207.boxd.sh/x207/circles/agents-main/bundles (`bundleId` 2)

## Earlier run: epoch 183 (not used as the main evidence)

The first run ([`demo-barter-cycle-epoch183.json`](demo-barter-cycle-epoch183.json)) completed every step with the same ring and the same figures: 81 gross, 72 cleared, residues 8/1/0. In the same epoch, the contract's overspend test ([`ct132-overspend-run.json`](https://github.com/x207-labs/contracts/blob/main/docs/testnet-epochs/ct132-overspend-run.json) in the contracts repository) ran on the same circle with bob as payer. Its first voucher, bob → alice for 75 credit, was accepted ([`GuQjUumDLVu86PqX5TqHDri1BrszuHgi7uxbH3PQfiRQ`](https://testnet.nearblocks.io/txns/GuQjUumDLVu86PqX5TqHDri1BrszuHgi7uxbH3PQfiRQ)). Its second, bob → dan3 for 75 credit, was refused by the contract with `ERR_INSUFFICIENT_CREDIT` ([`Dq9zmg4dTeK7M17f24wcwcGGEgtiefakrrn9A66aQXev`](https://testnet.nearblocks.io/txns/Dq9zmg4dTeK7M17f24wcwcGGEgtiefakrrn9A66aQXev)). The accepted voucher made the epoch total 156 credit, with bob paying 68 USDT ([settle tx](https://testnet.nearblocks.io/txns/4aaZmgB3CnCCSMkdJnHM6XvaWVB9hjQkgkkgvSxNX799)). The ring itself still netted to 8. The script now records such extra vouchers under `other_obligations_in_epoch`, and the run was repeated in epoch 184, where there were none. Dashboard: https://x207.vercel.app/stats?epoch=183&circle=v018

## Running it again

```bash
X207_MEMBER_KEYS_FILE=<keys.json> X207_DEMO_OUT=<state.json> node scripts/demo-barter-cycle.ts
```

- **Keys.** The keys file maps a member name to `{ access, voucher }` keys. The script never prints them or writes them out.
- **Members.** `X207_RING` sets the ring as `name:account[:keyEntry]`. dan2's voucher key is held under another entry of the keys file; the account changed hands in an earlier test.
- **Restarts.** The state file records every finished step, so a stopped run resumes where it stopped.
- **Finished runs.** On a finished state file, the script only writes the evidence again. Move the file away to start a new run.
- **Epoch steps.** The script sends `close_epoch`, `commit_epoch` and `finalize_epoch` itself as soon as each is due, whether or not the circle keeper has sent it yet. The keeper never submits a clearing, so the script also sends `submit_clearing` and the claims. Every write goes to the contract; the backend stays read-only.
