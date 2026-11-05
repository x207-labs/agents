# AG-033: live NEAR AI Cloud run of the demo agents

Date: 2026-11-05. Model: `z-ai/glm-5.3-flash` (ADR-33). `NEARAI_MODE=live`. The key stays in `agents/.env`; it is not printed, logged or copied.

## What was run

`node scripts/ag033-live-run.ts` starts each of the six agent servers (`createAgentServer`, no paywall: this run measures the model, not the payment), calls `GET /api/<verb>?input=...` once, and reads the token counts from the `usage` field of the NEAR AI response. The client logs `[nearai] agent=<name> usage prompt_tokens=N completion_tokens=M` (counts only, no text).

Price list from `GET /v1/model/list`: input 80e-9 USD per token, output 500e-9 USD per token.

## Result

| Agent | HTTP | Input tokens | Output tokens | Cost (USD) | Latency |
|---|---|---|---|---|---|
| translator | 200 | 43 | 86 | 0.000046 | 3.0 s |
| summarizer | 200 | 62 | 226 | 0.000118 | 5.8 s |
| scraper | 200 | 59 | 136 | 0.000073 | 1.8 s |
| image | 200 | 47 | 240 | 0.000124 | 5.1 s |
| cleaner | 200 | 55 | 519 | 0.000264 | 9.0 s |
| gpu | 200 | 44 | 164 | 0.000086 | 3.7 s |
| **Total** | | 310 | 1371 | **0.000710** | |

Total spend about $0.0007 of the $0.10 budget. A paid agent call costs between $0.00005 and $0.00026 of inference, so the x402 price per call must be above that to leave margin.

## Swarm demo

`npm run demo:swarm` (`demo/swarm.demo.ts`) was run with `NEARAI_MODE=live`. That demo signs and registers vouchers between the six agents on near-sandbox; it does not start the agent servers and makes no NEAR AI call, so it adds no inference cost. The only demo that serves the agents with the model is `demo/network.demo.ts` (testnet). boxd and hosted deployments were not changed to live.

## AG-034: live NEAR AI answers inside a full testnet epoch

Date: 2026-11-05. Circle `x207-rh-circle.testnet` (interface 0.0.13, the rehearsal circle; the older `x207r-circle.testnet` is 0.0.1 and does not match the SDK). Six fresh agents `{translator,summarizer,scraper,image,cleaner,gpu}.x207rh-scraper.testnet`, stake 2.000000 each, mock USDT `usdt.x207-deployer.testnet`, keeper `x207rh-keeper.testnet`, solver `solver.x207rh-keeper.testnet`, relayer `relayer.x207rh-keeper.testnet`. Command: `npm run demo:testnet` in the umbrella repository with `X207_DEMO_NEARAI=live`, `DEMO_PAYMENTS=18` and the key from `agents/.env` (never printed). boxd stays mock. The run took about 29 minutes.

Epoch 12: the agents bought services from each other through x402 with x207 vouchers, every answer came from NEAR AI Cloud (18 calls, all `mode=live status=200`), the solver cleared 280000 of 360000 credit, two debtors paid the residual, two creditors claimed.

| Stage | Transaction |
|---|---|
| keeper.close_epoch | `BWC36fuoYMVw88hyHkZbD1Cajmt4mv4BaK97Vnxuyf7a` |
| solver.submit_clearing | `6A9WjRQw3h3Ju2CgHE29TQi1zioKCxQJVinjw1wSB1qC` |
| keeper.commit_epoch | `621CPkQ2diTG2HLohw144pedywTM4NyW8viG7QMYivgX` |
| translator.settle (ft_transfer_call) | `GjFJbJWj51p1f85qiEdEHT8fjMGx3h3mGrHsDLgMnVXH` |
| summarizer.settle (ft_transfer_call) | `EuomR3rSPKPXtuaWx7ugWu1EriGB9B7BhQ3KW6SbvGpA` |
| keeper.finalize_epoch | `95YKuhNQXH2s6fqZCek7Hc4QiypNnFQgSXHzgeG8h6EG` |
| cleaner.claim | `335ata3u53gQFN31t7DUkadZ4c5kRKimUmtjeADSdcpm` |
| gpu.claim | `FzzcE4YgFdy6c2bgbcv8PQWekyDU4FxtvDaT8jFUFtvv` |

The 12 voucher registrations by the relayer (`relayer.register`, one per buyer/seller pair) and every other hash are in `docs/testnet-ag034-live.json` of the umbrella repository (18 vouchers, 12 edges). The hashes of the close, commit and finalize of the neighbouring epochs that the keeper pass sent in the same run are in that file too.

Tokens and cost per agent (model `z-ai/glm-5.3-flash`, 80e-9 USD per input token, 500e-9 per output token; the buyers send the input `halo`, so the answers are longer than in the table above):

| Agent | Calls | Input tokens | Output tokens | Cost (USD) |
|---|---|---|---|---|
| translator | 2 | 70 | 127 | 0.000069 |
| summarizer | 3 | 105 | 466 | 0.000241 |
| scraper | 4 | 144 | 955 | 0.000489 |
| image | 3 | 105 | 489 | 0.000253 |
| cleaner | 3 | 123 | 1288 | 0.000654 |
| gpu | 3 | 111 | 575 | 0.000296 |
| **Total** | 18 | 658 | 3900 | **0.002003** |

Latency per call 1.2 s to 14 s. Inference for the whole epoch cost about $0.002 against a limit of $0.05; the earlier smoke run of AG-033 cost $0.0007, so the AG-034 work in total stayed under $0.01 (two earlier runs of the epoch used the mock model because `demo/vitest.config.mts` forced `NEARAI_MODE=mock`; that is now switchable with `X207_DEMO_NEARAI=live`).

Problems met on the way, for the next person who runs it:
- The public testnet RPCs are rate limited or deprecated (`rpc.testnet.near.org`, `rpc.testnet.pagoda.co` answer 429 for transactions). `rpc.testnet.fastnear.com` and `near-testnet.drpc.org` work most of the time; list both in `RPC_URLS`.
- An RPC answered `Internal server error` for the stake `ft_transfer_call` after the stake had landed, which left two agents active on-chain with their voucher key unsaved. `demo/network.demo.ts` now asks the contract whether the member is active before it fails, so onboarding goes on.
- An agent that is registered but not active cannot be onboarded again; use new account names.
- vitest hides `console.log` of the agents in live mode; the client now writes its log lines with `writeSync(1, ...)`.
