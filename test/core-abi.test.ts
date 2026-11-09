import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ContractAbi } from "@x207/core";

const X207_CIRCLE_ABI_VERSION = ContractAbi.X207_CIRCLE_ABI_VERSION;

// AG-040 (A-AG-12): the agents must run against the @x207/core of the umbrella workspace (ABI 0.0.18 on the branch p1-0.0.18, 0.0.17 on main), never the npm tarball 0.0.2, which carries ABI 0.0.15.
describe("AG-040 @x207/core is the workspace package at the contract ABI in use", () => {
  it("TC-AG-040-01 the ABI version is 0.0.18", () => {
    expect(X207_CIRCLE_ABI_VERSION).toBe("0.0.18");
  });

  it("TC-AG-040-02 @x207/core resolves to the workspace folder, not to a copy from the registry", () => {
    const resolved = realpathSync(createRequire(import.meta.url).resolve("@x207/core"));
    expect(resolved).toMatch(/sdk[\\/]packages[\\/]core[\\/]/);
    expect(resolved).not.toMatch(/node_modules[\\/]@x207[\\/]core[\\/]/);
  });
});
