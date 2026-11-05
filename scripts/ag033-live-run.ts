// AG-033: call every demo agent once against NEAR AI Cloud (NEARAI_MODE=live) through its own HTTP server and
// report tokens and cost per agent from the `usage` of the response. Run: node scripts/ag033-live-run.ts
// The key is read from .env by loadEnv and is never printed. Stops before a call when the budget is nearly used.
import type { AddressInfo } from "node:net";
import { loadEnv } from "../shared/config.ts";
import { createAgentServer } from "../shared/agent-server.ts";
import { createNearAiClient } from "../shared/nearai.ts";
import { AGENT_NAMES, AGENTS } from "../shared/registry.ts";

loadEnv();
process.env.NEARAI_MODE = "live";
// Price list of z-ai/glm-5.3-flash from GET /v1/model/list: 80e-9 USD per input token, 500e-9 per output token.
const IN = 80e-9;
const OUT = 500e-9;
const BUDGET = 0.1;
const INPUT: Record<string, string> = {
  translator: "Los agentes pagan por servicios con credito mutuo.",
  summarizer: "x207 lets AI agents buy and sell services over x402 and settle the net balance once per epoch instead of paying every call on chain.",
  scraper: "Epochs last 10 minutes. Agents stake 150 credit. The solver clears cycles. Net balances settle in USDT.",
  image: "Two agents trading services in a ring, settled by one net transfer.",
  cleaner: "  name:  Ada ,, age = 3o ;; city=Lagos   ",
  gpu: "Render 100 frames at 1080p",
};

let total = 0;
const rows: string[] = [];
for (const name of AGENT_NAMES) {
  let prompt = 0;
  let completion = 0;
  const llm = createNearAiClient({
    agent: name,
    log: (line) => {
      const m = /prompt_tokens=(\d+) completion_tokens=(\d+)/.exec(line);
      if (m) {
        prompt = Number(m[1]);
        completion = Number(m[2]);
      }
    },
  });
  if (total >= BUDGET * 0.8) {
    console.log(`stop: spent $${total.toFixed(6)}, budget $${BUDGET}`);
    break;
  }
  const server = createAgentServer(AGENTS[name], llm); // no paywall: this run measures the model, not the payment
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${AGENTS[name].verb}?input=${encodeURIComponent(INPUT[name])}`;
  const started = Date.now();
  const res = await fetch(url);
  const body = (await res.json()) as { result?: string; error?: string };
  server.close();
  const cost = prompt * IN + completion * OUT;
  total += cost;
  const row = `${name} | http ${res.status} | ${llm.model} | in ${prompt} | out ${completion} | $${cost.toFixed(6)} | ${Date.now() - started} ms | ${(body.result ?? body.error ?? "").replace(/\s+/g, " ").slice(0, 70)}`;
  rows.push(row);
  console.log(row);
}
console.log(`total $${total.toFixed(6)} (budget $${BUDGET})`);
