import { createServer, type Server } from "node:http";
import { loadEnv } from "./config.ts";
import { createNearAiClient, NearAiConfigError, NearAiError, type LlmClient } from "./nearai.ts";
import type { AgentSpec } from "./registry.ts";

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createAgentServer(spec: AgentSpec, llm: LlmClient): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, agent: spec.name });
    }
    if (req.method === "GET" && url.pathname === `/api/${spec.verb}`) {
      const input = url.searchParams.get("input");
      if (!input) return send(res, 400, { error: "missing_input" });
      try {
        return send(res, 200, { agent: spec.name, result: await llm.complete(spec.system, input) });
      } catch (e) {
        // Failed inference is a 5xx so the x402 middleware does not settle it (K-48).
        if (e instanceof NearAiError) return send(res, 502, { error: "inference_failed", upstreamStatus: e.status });
        throw e;
      }
    }
    send(res, 404, { error: "not_found" });
  });
}

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
  const server = createAgentServer(spec, llm);
  server.listen(port, () => console.log(`[${spec.name}] listening on :${port} (llm=${llm.mode}, model=${llm.model})`));
  return server;
}
