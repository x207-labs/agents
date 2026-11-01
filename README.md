# x207 agents

Six demo agents that buy and sell services over x402, settled as mutual credit by x207. They use only the public packages `@x402/fetch`, `@x207/scheme` and `@x207/core`. Module M7, features F1, F2 and F5. Part of [x207](https://github.com/x207-labs/x207).

| Agent | Folder | Default port |
| --- | --- | --- |
| translator | `agents/translator` | 4201 |
| summarizer | `agents/summarizer` | 4202 |
| scraper | `agents/scraper` | 4203 |
| image | `agents/image` | 4204 |
| cleaner | `agents/cleaner` | 4205 |
| gpu | `agents/gpu` | 4206 |

Override a port with `<NAME>_PORT`, e.g. `TRANSLATOR_PORT=5001`. `scenario/` holds the demo scenarios.

## Run

```bash
npm run agent -- agents/translator/index.ts
curl localhost:4201/health
```

## Test

```bash
npm test
npm run typecheck
```

## Config

Copy `.env.example` to `.env` and fill it by hand. `.env` is git-ignored; only `.env.example` is committed.

Node 26 runs the `.ts` files directly (type stripping), so there is no build step.

## NEAR AI Cloud inference

Every agent answers through the one shared client in `shared/nearai.ts` (OpenAI-compatible endpoint `https://cloud-api.near.ai/v1`, `POST /chat/completions`; ADR-12). It is the only module that holds the URL. Default model `z-ai/glm-5.3-flash` (ADR-33), override with `NEARAI_MODEL`.

- Each agent serves `GET /api/<verb>?input=...` (translate, summarize, scrape, image, clean, compute). Failed inference returns 502 so the x402 middleware does not settle the call.
- Each call logs one line: `[nearai] agent=… model=… mode=… status=… latency=…ms`. Keys and prompts are never logged.
- Inference text is never written to the contract or D9.

| `NEARAI_MODE` | Behavior |
| --- | --- |
| `live` (default) | Calls NEAR AI Cloud. Needs `NEARAI_API_KEY`; an empty key stops the agent with a message naming the variable. |
| `mock` | Canned answer `[mock:<agent>] <input>`, no network, no credits. Tests always use mock. |

Run an agent without credits:

```bash
NEARAI_MODE=mock npm run agent -- agents/summarizer/index.ts
curl "localhost:4202/api/summarize?input=hello"
```
