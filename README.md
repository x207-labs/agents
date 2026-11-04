# x207 agents

Six demo agents that buy and sell services over x402, settled as mutual credit by [x207](https://github.com/x207-labs/x207).

## Its role in x207

The agents show what the layer is for. Each one sells a small service (translate, summarize, scrape, image, clean, compute) behind an x402 paywall and buys from the others, paying with signed vouchers instead of one transfer per call. They use only public packages: `@x402/fetch`, `@x207/scheme` and `@x207/core` from the [SDK](https://github.com/x207-labs/sdk). The `scenario/` folder holds the scenarios that the demos and end-to-end tests of the umbrella (`demo/`) import, run against the [contract](https://github.com/x207-labs/contracts).

| Agent | Folder | Default port | Route |
| --- | --- | --- | --- |
| translator | `agents/translator` | 4201 | `GET /api/translate?input=...` |
| summarizer | `agents/summarizer` | 4202 | `GET /api/summarize?input=...` |
| scraper | `agents/scraper` | 4203 | `GET /api/scrape?input=...` |
| image | `agents/image` | 4204 | `GET /api/image?input=...` |
| cleaner | `agents/cleaner` | 4205 | `GET /api/clean?input=...` |
| gpu | `agents/gpu` | 4206 | `GET /api/compute?input=...` |

Override a port with `<NAME>_PORT`, for example `TRANSLATOR_PORT=5001`.

## Try it

Without credits or a network, in mock mode:

```bash
npm install
NEARAI_MODE=mock npm run agent -- agents/summarizer/index.ts
curl "localhost:4202/api/summarize?input=hello"
```

Mock mode answers `[mock:<agent>] <input>`. The full story, six agents trading for four epochs on a local circle, is `npm run demo:swarm` in the [umbrella](https://github.com/x207-labs/x207#run-it-locally-5-minutes).

## Test

```bash
npm test
npm run typecheck
npm run test:sandbox    # X207_SANDBOX=1, needs near-sandbox (run from the umbrella)
```

Node 26 runs the `.ts` files directly (type stripping), so there is no build step. Copy `.env.example` to `.env` and fill it by hand; `.env` is git-ignored.

## Inference on NEAR AI Cloud

Every agent answers through one shared client, `shared/nearai.ts` (OpenAI-compatible endpoint `https://cloud-api.near.ai/v1`, ADR-12). Default model `z-ai/glm-5.3-flash` (ADR-33), override with `NEARAI_MODEL`.

| `NEARAI_MODE` | Behavior |
| --- | --- |
| `live` (default) | Calls NEAR AI Cloud. Needs `NEARAI_API_KEY`; an empty key stops the agent with a message naming the variable |
| `mock` | Canned answer, no network. Tests always use mock |

A failed inference returns 502, so the x402 middleware does not settle the call. Each call logs one line (`[nearai] agent=… model=… mode=… status=… latency=…ms`); keys and prompts are never logged, and inference text is never written to the contract.

## Back to x207

Overview, live demo links and the claims map: [x207-labs/x207](https://github.com/x207-labs/x207).

## License

Apache-2.0
