import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractAbi } from "@x207/core";

const X207_CIRCLE_ABI_VERSION = ContractAbi.X207_CIRCLE_ABI_VERSION;
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const pinned: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@x207/core"];

/** The package.json of the installed `@x207/core`: the nearest one above its entry file. */
function installedCore(entry: string): { name: string; version: string } {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@x207/core") return pkg;
    } catch {
      // no package.json here: go up
    }
  }
  throw new Error(`no package.json of @x207/core above ${entry}`);
}

// AG-040 (A-AG-12): the agents must run against an @x207/core at the contract ABI in use (0.0.18), never the npm tarball 0.0.2, which carries ABI 0.0.15. Inside the
// umbrella that is the workspace package; in a repository cloned alone it is the registry copy pinned in package.json (0.0.3).
describe("AG-040 @x207/core is at the contract ABI in use", () => {
  it("TC-AG-040-01 the ABI version is 0.0.18", () => {
    expect(X207_CIRCLE_ABI_VERSION).toBe("0.0.18");
  });

  it("TC-AG-040-02 @x207/core resolves to the workspace folder, or to the registry copy of the pinned version", () => {
    const resolved = realpathSync(createRequire(import.meta.url).resolve("@x207/core"));
    if (/sdk[\\/]packages[\\/]core[\\/]/.test(resolved)) return;
    expect(resolved).toMatch(/node_modules[\\/]@x207[\\/]core[\\/]/);
    expect(installedCore(resolved).version).toBe(pinned);
  });
});
