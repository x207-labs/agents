# x207 agents

Six demo agents that buy and sell services over x402, settled by multilateral clearing by [x207](https://github.com/x207-labs/x207).

## Its role in x207

The agents show what the layer is for. Each one sells a small service (translate, summarize, scrape, image, clean, compute) behind an x402 paywall and buys from the others, paying with signed vouchers instead of one transfer per call. Their source uses only public packages (the tests reach further, see Test): `@x402/fetch`, `@x207/scheme` and `@x207/core` from the [SDK](https://github.com/x207-labs/sdk). The `scenario/` folder holds the scenarios that the demos and end-to-end tests of the umbrella (`demo/`) import, run against the [contract](https://github.com/x207-labs/contracts).

```mermaid
sequenceDiagram
  participant B as Buyer agent
  participant A as Seller agent
  participant N as NEAR AI Cloud
  participant F as Facilitator
  B->>A: GET /api/summarize
  A-->>B: 402 (x207 voucher or exact)
  B->>A: retry with signed voucher
  A->>F: verify
  A->>N: chat completion
  alt inference ok
    N-->>A: text
    A-->>B: 200 + PAYMENT-RESPONSE
  else inference fails
    A-->>B: 502, nothing settles
  end
```

| Agent | Folder | Default port | Route |
| --- | --- | --- | --- |
| translator | `agents/translator` | 4201 | `GET /api/translate?input=...` |
| summarizer | `agents/summarizer` | 4202 | `GET /api/summarize?input=...` |
| scraper | `agents/scraper` | 4203 | `GET /api/scrape?input=...` |
| image | `agents/image` | 4204 | `GET /api/image?input=...` |
| cleaner | `agents/cleaner` | 4205 | `GET /api/clean?input=...` |
| gpu | `agents/gpu` | 4206 | `GET /api/compute?input=...` |

Override a port with `<NAME>_PORT` (the agent name in capitals), for example `TRANSLATOR_PORT=5001` or `GPU_PORT=5006`.

An agent listens on `127.0.0.1` (AG-038). `AGENT_HOST` picks another interface, but a free endpoint (no `FACILITATOR_URL`) with a live `NEARAI_API_KEY` refuses to start on a non-loopback host. The free endpoint answers at most 30 calls a minute per client (429) and refuses `input` above 4000 characters (413). The live client stops a call after `NEARAI_TIMEOUT_MS` (default 30000) and asks for at most `NEARAI_MAX_TOKENS` (default 1024) tokens.

## Dependencies

`@x207/core` and `@x207/scheme` are not installed from npm: the registry holds `@x207/core@0.0.2`, which carries contract ABI 0.0.15, while the contract in use is 0.0.17 (AG-040; on the branch `p1-0.0.18` it is 0.0.18, the sale of a NEAR account, AG-050). The agents run inside the umbrella workspace (`x207-labs/x207`, `npm ci` at its root), where the packages are linked from `sdk/packages/`. The own `package-lock.json` of this folder (like the one of `solver`) still names the registry copy: the pins check wants a committed lockfile in every repo, and it is only used by a lone `npm ci` here, which is not how CI or the jury run it. `test/core-abi.test.ts` fails if the resolved `@x207/core` is not the workspace one at the ABI in use (0.0.17 on main, 0.0.18 on the branch `p1-0.0.18`).

## Try it

Needs Node 22.22.2 or newer. Without credits or a network, in mock mode (the agent has no paywall until `FACILITATOR_URL` is set, so the call below is free):

```bash
npm install
NEARAI_MODE=mock npm run agent -- agents/summarizer/index.ts
curl "localhost:4202/api/summarize?input=hello"
```

Mock mode answers `{"agent":"summarizer","result":"[mock:summarizer] hello"}`. The full story, six agents trading for four epochs on a local circle, is `npm run demo:swarm` in the [umbrella](https://github.com/x207-labs/x207#run-it-locally-5-minutes).

## Test

```bash
npm test
npm run typecheck
npm run test:sandbox    # X207_SANDBOX=1, needs near-sandbox (run from the umbrella)
```

`npm install` works on this repository alone, and so does the agent above. The end-to-end tests do not: `test/*.sandbox.test.ts` and `test/stack.ts` import the test support of the SDK, the facilitator and the umbrella scripts. On its own, `npm test` runs the other test files and reports those eight as failed, and `npm run typecheck` reports their imports. Run the tests from a recursive checkout of the [umbrella](https://github.com/x207-labs/x207) (`npm ci`, then `npm test -w @x207/agents`); the agents' source itself uses only the public packages (`npm run check:imports`).

Node 22.22.2 or newer runs the `.ts` files directly (type stripping is on by default since Node 22.18), so there is no build step. Copy `.env.example` to `.env` and fill it by hand; `.env` is git-ignored.

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
