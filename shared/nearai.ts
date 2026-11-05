// The only module that knows the NEAR AI Cloud endpoint (ADR-12). Inference text stays here
// and in the HTTP response of the agent; it is never written to the contract or D9.
import { writeSync } from "node:fs";

const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash"; // ADR-33; fallback Qwen/Qwen3.8-27B

export type LlmMode = "live" | "mock";

export class NearAiConfigError extends Error {}

export class NearAiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type LlmClient = {
  mode: LlmMode;
  model: string;
  complete(system: string, input: string): Promise<string>;
};

export type NearAiOptions = {
  agent: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

export function createNearAiClient(opts: NearAiOptions): LlmClient {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  // writeSync(1): a test runner that captures console.log (vitest) still shows these lines, so the token counts of a live demo are not lost (AG-034).
  const log = opts.log ?? ((line: string) => writeSync(1, `${line}\n`));
  const modeRaw = env.NEARAI_MODE || "live";
  if (modeRaw !== "live" && modeRaw !== "mock") {
    throw new NearAiConfigError(`NEARAI_MODE must be "live" or "mock", got "${modeRaw}"`);
  }
  const mode: LlmMode = modeRaw;
  const model = env.NEARAI_MODEL || DEFAULT_MODEL;
  const record = (status: string | number, started: number) =>
    log(`[nearai] agent=${opts.agent} model=${model} mode=${mode} status=${status} latency=${Date.now() - started}ms`);

  if (mode === "mock") {
    return {
      mode,
      model,
      async complete(_system, input) {
        const started = Date.now();
        const answer = `[mock:${opts.agent}] ${input}`;
        record("mock", started);
        return answer;
      },
    };
  }

  const apiKey = env.NEARAI_API_KEY;
  if (!apiKey) throw new NearAiConfigError("NEARAI_API_KEY is empty: set it in .env or use NEARAI_MODE=mock");
  const baseUrl = (env.NEARAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    mode,
    model,
    async complete(system, input) {
      const started = Date.now();
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: input },
            ],
          }),
        });
      } catch (e) {
        record("network_error", started);
        throw new NearAiError(`NEAR AI request failed: ${(e as Error).message}`, 0);
      }
      record(res.status, started);
      const body = (await res.json().catch(() => ({}))) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: { message?: { content?: string } }[];
        error?: { message?: string; type?: string };
      };
      if (!res.ok) {
        throw new NearAiError(body.error?.message ?? `NEAR AI returned ${res.status}`, res.status, body.error?.type);
      }
      // AG-033: token counts only (no text, no key), so the cost per agent can be read from the log.
      if (body.usage) log(`[nearai] agent=${opts.agent} usage prompt_tokens=${body.usage.prompt_tokens ?? 0} completion_tokens=${body.usage.completion_tokens ?? 0}`);
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new NearAiError("NEAR AI response has no message content", res.status);
      return content;
    },
  };
}
