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
