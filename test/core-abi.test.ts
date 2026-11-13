import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ContractAbi } from "@x207/core";
import { NEEDED_ABI, SDK_TOO_OLD, SDK_TOO_OLD_REASON } from "./installed-sdk.ts";

const X207_CIRCLE_ABI_VERSION = ContractAbi.X207_CIRCLE_ABI_VERSION;

// AG-040 (A-AG-12): the agents must run against the @x207/core of the umbrella workspace (ABI 0.0.18 on the branch p1-0.0.18, 0.0.17 on main), never the npm tarball 0.0.2, which carries ABI 0.0.15.
// AG-053: a repository cloned alone installs that tarball, so both tests skip, with the reason, while the installed core is older than the ABI needed. In the umbrella they run.
describe("AG-040 @x207/core is the workspace package at the contract ABI in use", () => {
  it("TC-AG-040-01 the ABI version is 0.0.18", (ctx) => {
    if (SDK_TOO_OLD) ctx.skip(SDK_TOO_OLD_REASON);
    expect(X207_CIRCLE_ABI_VERSION).toBe(NEEDED_ABI);
  });

  it("TC-AG-040-02 @x207/core resolves to the workspace folder, not to a copy from the registry", (ctx) => {
    if (SDK_TOO_OLD) ctx.skip(SDK_TOO_OLD_REASON);
    const resolved = realpathSync(createRequire(import.meta.url).resolve("@x207/core"));
    expect(resolved).toMatch(/sdk[\\/]packages[\\/]core[\\/]/);
    expect(resolved).not.toMatch(/node_modules[\\/]@x207[\\/]core[\\/]/);
  });
});
