import { createServer, type Server } from "node:http";
import type { AgentSpec } from "./registry.ts";

export function createAgentServer(spec: AgentSpec): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: spec.name }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

export function startAgent(spec: AgentSpec): Server {
  const port = Number(process.env[`${spec.name.toUpperCase()}_PORT`] ?? spec.port);
  const server = createAgentServer(spec);
  server.listen(port, () => console.log(`[${spec.name}] listening on :${port}`));
  return server;
}
