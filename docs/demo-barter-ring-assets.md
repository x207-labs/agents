# AG-055: barter ring with asset delivery on testnet v018

Date: 2026-11-13/14 UTC. Contract `x207-v018.testnet` (interface 0.0.18), circle `agents-main`, NFT contract `nft.x207-b1-aux.testnet` (mock NFT, `contracts/probes/mock_nft`), settlement token `usdt.x207-deployer.testnet` (mock USDT). Script: [`scripts/demo-barter-ring-assets.ts`](../scripts/demo-barter-ring-assets.ts), pure logic in [`scripts/lib/ring-assets.ts`](../scripts/lib/ring-assets.ts) (unit tests: [`test/ring-assets.test.ts`](../test/ring-assets.test.ts)). Full evidence: [`demo-barter-ring-assets.json`](demo-barter-ring-assets.json) (epoch 245).

## What it shows

The AG-052 ring ([`demo-barter-cycle.md`](demo-barter-cycle.md), epoch 184) moved only credit: no asset was delivered. This run closes that gap. Three members each sell one class A asset, an NFT, to the next member: alice → bob → dan2 → alice. Each NFT really moves:

1. The seller offers the NFT as a class A grant at a price (`offer_grant`).
2. The seller hands the NFT to the circle (`nft_transfer_call` on the NFT contract). The circle holds it: event `escrow_held`, owner of the token = `x207-v018.testnet`.
3. The buyer calls `complete_escrow` with a voucher of the price. In the same call the voucher is registered (event `voucher_registered`) and the circle sends the NFT to the buyer. `on_escrow_resolved` makes the grant active (event `grant_activated`), and the owner of the token is now the buyer.

The three purchases fall in one epoch (245), so the three debts form one cycle. At the end of the epoch, clearing nets 24 credit on every edge. 9 credit of debt is left (dan2 owes bob 8, alice owes dan2 1), and netting turns it into 8 mock USDT of payments: alice pays 1, dan2 pays 7, bob claims 8. The three assets moved in full.

## Who ran it

One script, run by one operator, played all three members. Each member has its own NEAR account, access key and voucher key. The script signs each member's part with that member's keys only: the seller signs `offer_grant` and `nft_transfer_call`, the buyer signs `complete_escrow` and its voucher, the net debtor signs its USDT payment, the creditor signs its claim.

The permissionless calls went to one member acting as relayer. dan2 sent the three `nft_mint` calls of the mock NFT and `close_epoch`. bob sent `submit_clearing`, `finalize_epoch` and its own claim. The keeper of the circle (`x207-v013-aux.testnet`) sent `commit_epoch` first.

This shows the contract's rules on real accounts, keys and tokens. It does not show three independent operators agreeing on a trade.

## Assets and prices

The three asset types come from the barter catalog (`scripts/lib/asset-catalog.mjs` in the umbrella repo): #5 `license:software-nft`, #2 `ticket:event-nft`, #3 `game:item-nft`, all class A, delivery `escrow_nft`. The circle v018 did not know them yet, so the owner of the circle registered them from the catalog first (`set_asset_class`, three transactions below).

Each asset was sent to the live appraiser (`POST https://v018.x207.boxd.sh/x207/appraise`). The appraiser was told the truth: the token is a mock NFT on NEAR testnet that stands for the asset. Its signature was verified and its attestation was checked, and it valued the tokens at about nothing:

| Seller | Asset | Appraised | Range | Confidence | Flags | Appraisal |
|---|---|---|---|---|---|---|
| alice | `license:software-nft`: one 12-month code editor seat as an NFT | 0 | 0–0 | 0.1 | `provider_unknown`, `no_market_price` | [`apr_6b39593ef870414295e68916`](https://v018.x207.boxd.sh/x207/appraisals/apr_6b39593ef870414295e68916) |
| bob | `ticket:event-nft`: one conference admission as an NFT | 0 | 0–0 | 0.1 | `no_market_price`, `provider_unknown`, `scope_unclear` | [`apr_46f4cf3721dbf5654341ae6b`](https://v018.x207.boxd.sh/x207/appraisals/apr_46f4cf3721dbf5654341ae6b) |
| dan2 | `game:item-nft`: one rare sword of an on-chain game as an NFT | 0.5 | 0.1–1 | 0.3 | `price_far_from_market`, `provider_unknown`, `transferability_risk` | [`apr_5e4d612bb36446df7d765a7a`](https://v018.x207.boxd.sh/x207/appraisals/apr_5e4d612bb36446df7d765a7a) |

That answer is right: a mock token on testnet has no market value. A ring at 0 credit has nothing to clear, so the ring uses **fixed prices: 24, 32 and 25 credit** (the magnitudes of AG-052). The script uses the appraised values only when all three are signed, positive and not all equal; otherwise it uses the fixed prices and keeps the reason in `result.pricing`. These prices are set by the operator, not by the appraiser.

## The ring (epoch 245)

Token ids `ag055-1794613317-*` on `nft.x207-b1-aux.testnet`. Owners are read with the view `nft_token`.

| Leg | Token | Grant | Price | Owner before | Owner in escrow | Owner after |
|---|---|---|---|---|---|---|
| alice → bob | `ag055-1794613317-license` (`license:software-nft`) | 9 | 24 | alice | `x207-v018.testnet` | **bob** |
| bob → dan2 | `ag055-1794613317-ticket` (`ticket:event-nft`) | 10 | 32 | bob | `x207-v018.testnet` | **dan2** |
| dan2 → alice | `ag055-1794613317-game-item` (`game:item-nft`) | 11 | 25 | dan2 | `x207-v018.testnet` | **alice** |

Members are `alice.x207-v18-own.testnet`, `bob.x207-v18-own.testnet` and `dan2.x207-v18-own.testnet`. After the run each token is still held by its buyer (`owner_now` in the JSON).

Each buyer owes its seller the price. The clearing:

| Debt (buyer owes seller) | Gross | Cleared | Residue |
|---|---|---|---|
| bob → alice (license) | 24 | 24 | 0 |
| dan2 → bob (ticket) | 32 | 24 | 8 |
| alice → dan2 (game item) | 25 | 24 | 1 |
| **Total** | **81** | **72** | **9** |

| Member | Sold | Bought | Owed (gross) | Owes (gross) | Net after clearing | USDT |
|---|---|---|---|---|---|---|
| alice | license to bob | game item of dan2 | 24 | 25 | −1 | paid 1 |
| bob | ticket to dan2 | license of alice | 32 | 24 | +8 | claimed 8 |
| dan2 | game item to alice | ticket of bob | 25 | 32 | −7 | paid 7 |

Without the barter, each leg would be paid in full: 81 USDT. With it, 8 USDT moved (987 bps of the gross). Epoch 245 has no other obligations. On chain, epoch 245 is `finalized` with `total_obligation` 81000000, `total_cleared` 72000000, `shortfall` 0. The script checks that the chain matches the plan of `clearRing` (`chain_matches_plan: true`).

## Transactions

Every hash below was read back from the archival node `https://archival-rpc.testnet.fastnear.com` with the `tx` method and the params object `{tx_hash, sender_account_id, wait_until: "FINAL"}`: all 24 are `FINAL` and have no failure (`result.archival_check`).

| Step | Signer | Transaction |
|---|---|---|
| `set_asset_class ticket:event-nft` | `x207-v18-own.testnet` (owner) | `FZEwSumTmmTSPnUkCsegUWrF2SvyoNXau233cWrNJ5R7` |
| `set_asset_class game:item-nft` | owner | `HcE4uXMEXtU1qXf43fEBtSyXe7xcq8m6VxjSJk9HHBTv` |
| `set_asset_class license:software-nft` | owner | `23RSGUUwMfqSMmuX86vCNdKQzoiLnT92L4ijV7FPgPLw` |
| `nft_mint` license to alice | dan2 | `DSwRmXfsx5BFVuaKqR2cRjwHuM1RXBYYWeNZwpwTaYyh` |
| `offer_grant` alice, license, 24 (grant 9) | alice | `EpHVhsBwPF8mcinxr1auz3AjYkmTSsNjJMWjxrGXqek6` |
| `nft_transfer_call` license → escrow (`escrow_held`) | alice | `34szXeLQstDGusqc8YhpcCQ3XRFnSjQtVyJCBhXXp98v` |
| `nft_mint` ticket to bob | dan2 | `9dLVK4Hh4hrHsUoumaUfNdzoPpeQPMf6Tj3cGoPCxPkn` |
| `offer_grant` bob, ticket, 32 (grant 10) | bob | `94CA4SbxbrYQhnWxqXpR91znfm5VhJYs7nyvENdyB9vu` |
| `nft_transfer_call` ticket → escrow (`escrow_held`) | bob | `4mGMGGwHkmMi1SQcKwj8N5T964HqAW6DBTub8Jyoh2Zp` |
| `nft_mint` game item to dan2 | dan2 | `5o2Y8UY1p7TD8FXqqZaAYi2mEpD3NzjcG7RkpamsGv2L` |
| `offer_grant` dan2, game item, 25 (grant 11) | dan2 | `7wZ2gPEwopuiX8ofVfZkvSRhjwgkXtkk4Mbgb1EJpcU4` |
| `nft_transfer_call` game item → escrow (`escrow_held`) | dan2 | `Edq6aEQPzbRrRy3nB7XYjLcAZCbdCYKUDuFayTq5AKg` |
| `complete_escrow` bob buys the license (`voucher_registered`, `grant_activated`) | bob | `GWF3npguAhQALgfAjb7evpeDhGYHdWzD1yLwm3yGrp9K` |
| `complete_escrow` dan2 buys the ticket | dan2 | `4ajpqavyrhBqhd6uBTMzKVkEAN5XzEtY4RfLXVarA7tz` |
| NEAR transfer 0.5 to alice (gas, see limits) | dan2 | `EvyDmeo97QU4Nhbihm1wGgj4dJuho2hQmyvMvQpH3QwB` |
| `complete_escrow` alice buys the game item | alice | `GmhhMhPjbMoucGJbCU9Qm7FaHXfkRCC1d6KdfeoXkvPz` |
| `close_epoch 245` (`epoch_cutoff`) | dan2 | `GNho5FtbCd25CXJog6tW8s1JBjArNqoaGXJDpt3aLg15` |
| `submit_clearing 245` (3 edges, 24 each) | bob | `9MfU2iY9Lt4XXTdSnnwqGnP4DRmZHhFdjMPFbtNdkXn9` |
| `commit_epoch 245` (`clearing_applied` with solver bob, `epoch_committed`) | keeper `x207-v013-aux.testnet` | `GaSauXHgid7qUxxWNqwjGkaRjhndpzvzYYXk2qKFbArV` |
| NEAR transfer 0.5 to dan2 (gas, see limits) | bob | `AV1tf8bnxWJo59RDnkYLXzKH1wykYhinDfE9Yxx2Ubc4` |
| settle: alice pays 1 USDT (`residual_paid`) | alice | `GhdHE2sdJR6K4Yvw1Bi3eTm6nhXRudCeb1HCKqwAR4wd` |
| settle: dan2 pays 7 USDT (`residual_paid`) | dan2 | `DKQXf66cXxq3DpjW2nSjqdHjrUMfKX6dB1TxVAvfJ11W` |
| `finalize_epoch 245` (`epoch_finalized`) | bob | `FTwZq3emNoYXfAoYwgGLX9fnHZ8KBTiVqF3EMSXUkTrA` |
| `claim` bob, 8 USDT (`residual_claimed`) | bob | `8M8Y12NXRS9Qktc8BKeY5uXbQ4d2irAuXsJCTCjrex1V` |

The commit hash of the keeper was found through the backend events (`GET /x207/circles/agents-main/events?event=epoch_committed`) and its signer through `EXPERIMENTAL_receipt`; then it was checked with `tx` like the others.

## Limits

- **Testnet only.** Mock USDT (`usdt.x207-deployer.testnet`), and a mock NFT contract (`nft.x207-b1-aux.testnet`, `probes/mock_nft`). Anyone can call `nft_mint` there. The tokens are not a real license, ticket or game item; they stand for the assets of the catalog.
- **Fixed prices.** The live appraiser valued the mock tokens at 0, 0 and 0.5 credit (signed, attestation checked). The prices 24/32/25 were set by the operator. This run does not show an appraised price on a delivered asset.
- **One operator** played all three members with their own keys. Not three independent operators.
- **v018 is owned by the team** (`get_owner` = `x207-v18-own.testnet`), not by a DAO. That owner registered the three asset types during this run.
- **Three separate purchases, not one bundle.** Each `complete_escrow` is its own transaction. If one had failed, or had fallen in another epoch, the ring would not have cleared. The script checks the time before each purchase (`complete_escrow` is refused in the last 120 s before the cutoff) and stops rather than split the ring.
- **Gas top-ups.** alice and dan2 had too little free NEAR for the gas of their calls (dan2 holds the locker code of its account sale, so most of its balance pays for storage). They each got 0.5 testnet NEAR from another member. These are plain transfers, not part of the barter.
- **One step was sent by hand.** The first `submit_clearing` attempt failed before it reached the chain (`LackBalanceForStateActionError` on the relayer dan2). The same edges were then sent from bob inside the proposal window, and the hash was added to the state file. The script now picks the relayer by free NEAR (balance minus storage), so a rerun sends it itself.
- **Only class A NFTs.** Class B (revocable access) and class C (secrets through the broker) are not in this ring. Neither `cancel_escrow` nor a failed delivery was exercised.

## Running it again

```bash
X207_MEMBER_KEYS_FILE=<keys.json> X207_OWNER_KEY_FILE=<owner key file> X207_DEMO_OUT=<state.json> node scripts/demo-barter-ring-assets.ts
```

Run it from the agents repo inside the umbrella workspace: it uses `near-api-js` of the sdk repo and the catalog of the umbrella repo. The keys file is the one of AG-052. The owner key file is only read when the circle does not know the three asset types. Each run mints new token ids, so a fresh state file starts a new ring. A state file with a finished run is not run again: only the evidence is read from the chain and written again. The run takes one epoch plus the payment window, about 50 minutes on v018.
