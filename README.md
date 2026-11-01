# x207 agents

Six demo agents that buy and sell services over x402, settled as mutual credit by x207. They use only the public packages `@x402/fetch`, `@x207/scheme` and `@x207/core`.

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
