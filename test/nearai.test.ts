import { readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentServer } from "../shared/agent-server.ts";
import { AGENT_NAMES, AGENTS } from "../shared/registry.ts";
import { createNearAiClient, DEFAULT_MODEL, NearAiConfigError, NearAiError } from "../shared/nearai.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const KEY = "sk-test-secret-key-123";
const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

async function ask(name: (typeof AGENT_NAMES)[number], llm: ReturnType<typeof createNearAiClient>, input = "hello") {
  const server = createAgentServer(AGENTS[name], llm);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/${AGENTS[name].verb}?input=${encodeURIComponent(input)}`);
  const body = await res.json();
  await new Promise((r) => server.close(r));
  return { res, body };
}

describe("AG-003 NEAR AI Cloud client", () => {
  it("TC-AG-003-01 all six agents answer through the shared client (live path, stubbed fetch)", async () => {
    const urls: string[] = [];
    const stub = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(init.body as string).model).toBe(DEFAULT_MODEL);
      return completion("done");
    }) as unknown as typeof fetch;
    for (const name of AGENT_NAMES) {
      const llm = createNearAiClient({ agent: name, env: { NEARAI_MODE: "live", NEARAI_API_KEY: KEY }, fetch: stub, log: () => {} });
      const { res, body } = await ask(name, llm);
      expect(res.status).toBe(200);
      expect(body).toEqual({ agent: name, result: "done" });
    }
    expect(urls).toHaveLength(6);
    expect(new Set(urls)).toEqual(new Set(["https://cloud-api.near.ai/v1/chat/completions"]));
  });

  it("TC-AG-003-01 mock mode answers without network", async () => {
    let fetched = false;
    const stub = (async () => ((fetched = true), completion("x"))) as unknown as typeof fetch;
    for (const name of AGENT_NAMES) {
      const llm = createNearAiClient({ agent: name, env: { NEARAI_MODE: "mock" }, fetch: stub, log: () => {} });
      const { res, body } = await ask(name, llm, "hi");
      expect(res.status).toBe(200);
      expect(body.result).toBe(`[mock:${name}] hi`);
    }
    expect(fetched).toBe(false);
  });

  it("TC-AG-003-02 the NEAR AI base URL appears only in the shared client module", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) f !== "node_modules" && f !== "test" && walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("cloud-api.near.ai")) hits.push(p.slice(root.length));
      }
    };
    for (const d of ["shared", "agents", "scenario"]) walk(`${root}${d}`);
    expect(hits).toEqual(["shared/nearai.ts"]);
  });

  it("TC-AG-003-03 one log line per call with agent, model, status, latency and no key", async () => {
    const lines: string[] = [];
    const llm = createNearAiClient({
      agent: "gpu",
      env: { NEARAI_MODE: "live", NEARAI_API_KEY: KEY },
      fetch: (async () => completion("ok")) as unknown as typeof fetch,
      log: (l) => lines.push(l),
    });
    await llm.complete("sys", "secret prompt text");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[nearai\] agent=gpu model=z-ai\/glm-5\.3-flash mode=live status=200 latency=\d+ms$/);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).not.toContain("secret prompt text");
  });

  it("TC-AG-003-05 NEAR AI 500 makes the agent answer 5xx", async () => {
    const llm = createNearAiClient({
      agent: "summarizer",
      env: { NEARAI_MODE: "live", NEARAI_API_KEY: KEY },
      fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
      log: () => {},
    });
    const { res, body } = await ask("summarizer", llm);
    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "inference_failed", upstreamStatus: 500 });
  });

  it("402 no_limit_configured surfaces as NearAiError and agent 5xx", async () => {
    const llm = createNearAiClient({
      agent: "image",
      env: { NEARAI_MODE: "live", NEARAI_API_KEY: KEY },
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "No spending limit configured.", type: "no_limit_configured" } }), { status: 402 })) as unknown as typeof fetch,
      log: () => {},
    });
    await expect(llm.complete("s", "i")).rejects.toMatchObject({ status: 402, code: "no_limit_configured" });
    await expect(llm.complete("s", "i")).rejects.toBeInstanceOf(NearAiError);
    expect((await ask("image", llm)).res.status).toBe(502);
  });

  it("TC-AG-002-03 live mode with empty key stops naming NEARAI_API_KEY only", () => {
    expect(() => createNearAiClient({ agent: "gpu", env: { NEARAI_MODE: "live", NEARAI_API_KEY: "" } })).toThrow(
      /NEARAI_API_KEY/,
    );
    expect(() => createNearAiClient({ agent: "gpu", env: { NEARAI_MODE: "live", NEARAI_API_KEY: "" } })).toThrow(NearAiConfigError);
  });

  it("rejects unknown NEARAI_MODE", () => {
    expect(() => createNearAiClient({ agent: "gpu", env: { NEARAI_MODE: "fake" } })).toThrow(/NEARAI_MODE/);
  });
});
