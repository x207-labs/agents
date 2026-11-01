import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccountId } from "@x207/core";
import { loadEnv } from "./config.ts";
import { createNearAiClient, NearAiConfigError, NearAiError, type LlmClient } from "./nearai.ts";
import type { AgentSpec } from "./registry.ts";
import { createSellerPaywall } from "./x207.ts";

/** Penjaga pembayaran x207 (x207Middleware dari @x207/scheme): Request web standar masuk, Response keluar. */
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

export function createAgentServer(spec: AgentSpec, llm: LlmClient, paywall?: Paywall): Server {
  const api = async (request: Request): Promise<Response> => {
    const input = new URL(request.url).searchParams.get("input");
    if (!input) return json(400, { error: "missing_input" });
    try {
      return json(200, { agent: spec.name, result: await llm.complete(spec.system, input) });
    } catch (e) {
      // Failed inference is a 5xx so the x402 middleware does not settle it (K-48).
      if (e instanceof NearAiError) return json(502, { error: "inference_failed", upstreamStatus: e.status });
      throw e;
    }
  };
  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json(200, { ok: true, agent: spec.name });
    if (request.method === "GET" && pathname === `/api/${spec.verb}`) {
      // Hanya endpoint berbayar yang lewat penjaga; /health tetap gratis.
      return paywall ? paywall(request, api) : api(request);
    }
    return json(404, { error: "not_found" });
  };
  return createServer(async (req, res) => {
    try {
      await writeResponse(res, await route(await toRequest(req)));
    } catch (e) {
      console.error(`[${spec.name}]`, e);
      await writeResponse(res, json(500, { error: "internal_error" }));
    }
  });
}

export type SellerConfig = {
  facilitatorUrl: string;
  circleId: string;
  /** Akun NEAR agent penjual yang menerima pembayaran. */
  payTo: AccountId;
  price?: string;
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
    console.error(`[${spec.name}] config error: CIRCLE_CONTRACT wajib diisi bila FACILITATOR_URL diisi`);
    process.exit(1);
  }
  // Tanpa FACILITATOR_URL agent melayani gratis (mode pengembangan AG-003).
  const paywall = facilitatorUrl
    ? createSellerPaywall(spec, {
        facilitatorUrl,
        circleId: process.env.CIRCLE_ID ?? "agents-main",
        payTo: `${spec.name}.${circleContract}`,
        ...(process.env.AGENT_PRICE ? { price: process.env.AGENT_PRICE } : {}),
      })
    : undefined;
  const server = createAgentServer(spec, llm, paywall);
  server.listen(port, () => console.log(`[${spec.name}] listening on :${port} (llm=${llm.mode}, model=${llm.model}, paywall=${paywall ? "x207" : "off"})`));
  return server;
}
