import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { bindProblem, createAgentServer, isLoopbackHost, type Paywall } from "../shared/agent-server.ts";
import { AGENTS } from "../shared/registry.ts";
import { createNearAiClient, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, NearAiConfigError, type LlmClient } from "../shared/nearai.ts";

// AG-038 (A-AG-04): the free endpoint binds loopback, is limited, caps its input; the live client has a timeout and max_tokens. No call goes to NEAR AI: the client is the
// mock or has a stubbed fetch.
const spec = AGENTS.summarizer;
const mockLlm: LlmClient = { mode: "mock", model: "m", complete: async (_s, input) => `ok:${input}` };

async function serve(llm: LlmClient, paywall?: Paywall, options = {}) {
  const server = createAgentServer(spec, llm, paywall, options);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/${spec.verb}`, close: () => new Promise((r) => server.close(r)) };
}

describe("AG-038 bind policy", () => {
  it("TC-AG-038-01 loopback hosts are recognised; a free live endpoint on another interface is refused", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
    expect(bindProblem("0.0.0.0", false, "live")).toMatch(/refusing to listen on 0\.0\.0\.0/);
    expect(bindProblem("0.0.0.0", true, "live")).toBeNull(); // behind the paywall
    expect(bindProblem("0.0.0.0", false, "mock")).toBeNull(); // no key to spend
    expect(bindProblem("127.0.0.1", false, "live")).toBeNull();
  });
});

describe("AG-038 limits of the free endpoint", () => {
  it("TC-AG-038-02 input above the cap is 413 before the model; calls above the rate are 429; a paywalled endpoint is not limited here", async () => {
    let calls = 0;
    const counting: LlmClient = { mode: "mock", model: "m", complete: async () => { calls += 1; return "x"; } };
    const s = await serve(counting, undefined, { maxInputChars: 10, rateLimitPerMinute: 3, now: () => 1_000 });
    expect((await fetch(`${s.url}?input=${"a".repeat(11)}`)).status).toBe(413);
    expect(calls).toBe(0);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${s.url}?input=hi`)).status);
    expect(statuses).toEqual([200, 200, 429, 429, 429]); // the 413 above already counted as one call
    expect(calls).toBe(2);
    await s.close();

    const paid: Paywall = async (request, next) => next(request);
    const p = await serve(mockLlm, paid, { rateLimitPerMinute: 1 });
    expect([(await fetch(`${p.url}?input=a`)).status, (await fetch(`${p.url}?input=b`)).status]).toEqual([200, 200]);
    await p.close();
  });

  it("TC-AG-038-03 the window slides: after a minute the client may call again", async () => {
    let now = 0;
    const s = await serve(mockLlm, undefined, { rateLimitPerMinute: 1, now: () => now });
    expect((await fetch(`${s.url}?input=a`)).status).toBe(200);
    expect((await fetch(`${s.url}?input=a`)).status).toBe(429);
    now = 61_000;
    expect((await fetch(`${s.url}?input=a`)).status).toBe(200);
    await s.close();
  });
});

describe("AG-038 live client has a timeout and max_tokens (stubbed fetch)", () => {
  const env = { NEARAI_MODE: "live", NEARAI_API_KEY: "sk-test" };

  it("TC-AG-038-04 the request carries max_tokens and an abort signal; env overrides; bad values are refused", async () => {
    const seen: Array<{ body: Record<string, unknown>; signal: unknown }> = [];
    const stub = (async (_url: string, init: RequestInit) => {
      seen.push({ body: JSON.parse(init.body as string), signal: init.signal });
      return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const log = () => undefined;
    await createNearAiClient({ agent: "t", env, fetch: stub, log }).complete("s", "i");
    await createNearAiClient({ agent: "t", env: { ...env, NEARAI_MAX_TOKENS: "50", NEARAI_TIMEOUT_MS: "1000" }, fetch: stub, log }).complete("s", "i");
    expect(seen[0]!.body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(seen[1]!.body.max_tokens).toBe(50);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(() => createNearAiClient({ agent: "t", env: { ...env, NEARAI_MAX_TOKENS: "0" } })).toThrow(NearAiConfigError);
    expect(() => createNearAiClient({ agent: "t", env: { ...env, NEARAI_TIMEOUT_MS: "abc" } })).toThrow(/NEARAI_TIMEOUT_MS/);
  });

  it("TC-AG-038-05 a call that does not answer within the timeout ends as an inference error (502 on the endpoint), not a hang", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const llm = createNearAiClient({ agent: "t", env: { ...env, NEARAI_TIMEOUT_MS: "50" }, fetch: hang, log: () => undefined });
    const s = await serve(llm);
    const res = await fetch(`${s.url}?input=hi`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "inference_failed", upstreamStatus: 0 });
    await s.close();
  });
});
