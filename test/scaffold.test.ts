import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentServer } from "../shared/agent-server.ts";
import { createNearAiClient } from "../shared/nearai.ts";
import { AGENT_NAMES, AGENTS } from "../shared/registry.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

describe("AG-001 scaffold", () => {
  it("TC-AG-001-01 six agent folders and scenario/ exist", () => {
    expect([...AGENT_NAMES]).toEqual(["translator", "summarizer", "scraper", "image", "cleaner", "gpu"]);
    for (const name of AGENT_NAMES) expect(existsSync(`${root}/agents/${name}/index.ts`)).toBe(true);
    expect(existsSync(`${root}/scenario`)).toBe(true);
  });

  it("TC-AG-001-02 @x402/fetch pinned to 2.28.0 and every dependency is exact", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@x402/fetch"]).toBe("2.28.0");
    for (const group of [pkg.dependencies, pkg.devDependencies]) {
      for (const [name, version] of Object.entries<string>(group)) {
        expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it("TC-AG-001-03 .env.example has names without values and .env is ignored", () => {
    const lines = read(".env.example").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^[A-Z_]+=$/);
    expect(read(".env.example")).toContain("NEARAI_API_KEY=");
    execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: root });
  });

  it("TC-AG-001-04 each agent serves /health as a local server", async () => {
    const ports = new Set<number>();
    for (const name of AGENT_NAMES) {
      const server = createAgentServer(AGENTS[name], createNearAiClient({ agent: name, env: { NEARAI_MODE: "mock" }, log: () => {} }));
      await new Promise<void>((r) => server.listen(0, r));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, agent: name });
      await new Promise((r) => server.close(r));
      ports.add(AGENTS[name].port);
    }
    expect(ports.size).toBe(6);
  });
});
