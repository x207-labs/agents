import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccountId } from "@x207/core";
import { loadEnv } from "./config.ts";
import { createNearAiClient, NearAiConfigError, NearAiError, type LlmClient } from "./nearai.ts";
import type { AgentSpec } from "./registry.ts";
import { createSellerPaywall } from "./x207.ts";

/** x207 payment guard (x207Middleware from @x207/scheme): a standard web Request comes in, a Response goes out. */
export type Paywall = (request: Request, next: (request: Request) => Response | Promise<Response>) => Promise<Response>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method ?? "GET", headers });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export const DEFAULT_MAX_INPUT_CHARS = 4_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export type AgentServerOptions = {
  /** `input` longer than this is refused with 413 before any model call; default 4000. */
  maxInputChars?: number;
  /** Calls per minute and per client address on the endpoint that is NOT behind the paywall (the paywall is the limit of a paid one); 0 = off; default 30. */
  rateLimitPerMinute?: number;
  now?: () => number;
};

/** A-AG-04: `true` for a loopback address of the bind host. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** A-AG-04: why this bind is refused, or `null`. A free (no paywall) endpoint that spends a live key is allowed only on loopback. */
export function bindProblem(host: string, paywalled: boolean, mode: LlmClient["mode"]): string | null {
  if (!paywalled && mode === "live" && !isLoopbackHost(host)) {
    return `refusing to listen on ${host}: the endpoint is free (no FACILITATOR_URL) and spends NEARAI_API_KEY; bind 127.0.0.1 (the default) or set FACILITATOR_URL, or use NEARAI_MODE=mock`;
  }
  return null;
}

export function createAgentServer(spec: AgentSpec, llm: LlmClient, paywall?: Paywall, options: AgentServerOptions = {}): Server {
  const maxInput = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const perMinute = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const clock = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  const limited = (client: string): boolean => {
    if (perMinute <= 0) return false;
    const now = clock();
    const recent = (hits.get(client) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(client, recent);
    if (hits.size > 10_000) for (const [key, list] of hits) if (list.every((t) => now - t >= 60_000)) hits.delete(key);
    return recent.length > perMinute;
  };
  const api = async (request: Request): Promise<Response> => {
    const input = new URL(request.url).searchParams.get("input");
    if (!input) return json(400, { error: "missing_input" });
    if (input.length > maxInput) return json(413, { error: "input_too_long", maxChars: maxInput });
    try {
      return json(200, { agent: spec.name, result: await llm.complete(spec.system, input) });
    } catch (e) {
      // Failed inference is a 5xx so the x402 middleware does not settle it (K-48).
      if (e instanceof NearAiError) return json(502, { error: "inference_failed", upstreamStatus: e.status });
      throw e;
    }
  };
  const route = async (request: Request, client: string): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json(200, { ok: true, agent: spec.name });
    if (request.method === "GET" && pathname === `/api/${spec.verb}`) {
      // Only paid endpoints go through the guard; /health stays free.
      if (paywall) return paywall(request, api);
      if (limited(client)) return json(429, { error: "rate_limited", perMinute });
      return api(request);
    }
    return json(404, { error: "not_found" });
  };
  return createServer(async (req, res) => {
    try {
      await writeResponse(res, await route(await toRequest(req), req.socket.remoteAddress ?? "unknown"));
    } catch (e) {
      console.error(`[${spec.name}]`, e);
      await writeResponse(res, json(500, { error: "internal_error" }));
    }
  });
}

export type SellerConfig = {
  facilitatorUrl: string;
  circleId: string;
  /** NEAR account of the selling agent that receives payment. */
  payTo: AccountId;
  price?: string;
  /** Clock for the `extra` cache (tests). */
  now?: () => number;
};

export function startAgent(spec: AgentSpec): Server {
  loadEnv();
  let llm: LlmClient;
  try {
    llm = createNearAiClient({ agent: spec.name });
  } catch (e) {
    if (e instanceof NearAiConfigError) {
      console.error(`[${spec.name}] config error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const port = Number(process.env[`${spec.name.toUpperCase()}_PORT`] ?? spec.port);
  const facilitatorUrl = process.env.FACILITATOR_URL;
  const circleContract = process.env.CIRCLE_CONTRACT;
  if (facilitatorUrl && !circleContract) {
    console.error(`[${spec.name}] config error: CIRCLE_CONTRACT is required when FACILITATOR_URL is set`);
    process.exit(1);
  }
  // Without FACILITATOR_URL the agent serves for free (development mode AG-003).
  const paywall = facilitatorUrl
    ? createSellerPaywall(spec, {
        facilitatorUrl,
        circleId: process.env.CIRCLE_ID ?? "agents-main",
        payTo: `${spec.name}.${circleContract}`,
        ...(process.env.AGENT_PRICE ? { price: process.env.AGENT_PRICE } : {}),
      })
    : undefined;
  // A-AG-04: loopback by default; `AGENT_HOST` opens another interface, which a free endpoint with a live key may not do
  const host = process.env.AGENT_HOST || "127.0.0.1";
  const problem = bindProblem(host, paywall !== undefined, llm.mode);
  if (problem) {
    console.error(`[${spec.name}] config error: ${problem}`);
    process.exit(1);
  }
  const server = createAgentServer(spec, llm, paywall);
  server.listen(port, host, () => console.log(`[${spec.name}] listening on ${host}:${port} (llm=${llm.mode}, model=${llm.model}, paywall=${paywall ? "x207" : "off"})`));
  return server;
}
