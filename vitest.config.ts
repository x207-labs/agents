import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// AG-053: the end-to-end tests (`test/*.sandbox.test.ts`) import the test support of the SDK, the facilitator and the scripts of the umbrella repository. When this
// repository is cloned alone those files are missing, so each sandbox test file is replaced by one skipped placeholder that names what is missing. Inside the umbrella
// workspace nothing is missing and the files run unchanged.
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const req = createRequire(import.meta.url);
const canResolve = (name: string): boolean => {
  try {
    req.resolve(name);
    return true;
  } catch {
    return false;
  }
};
const missing = [
  ...["../sdk/test-support/sandbox.ts", "../sdk/test-support/circle.ts", "../scripts/lib/asset-catalog.mjs"].filter((path) => !existsSync(here(path))).map((path) => path.slice(3)),
  ...["@x207/facilitator"].filter((name) => !canResolve(name)),
];
const SANDBOX_TEST = /[\\/]test[\\/][^\\/]+\.sandbox\.test\.ts$/;

// Tests never reach NEAR AI Cloud: mock mode and no key (ADR-33).
export default defineConfig({
  plugins:
    missing.length === 0
      ? []
      : [
          {
            name: "agents-skip-sandbox-without-umbrella",
            enforce: "pre" as const,
            transform(_code: string, id: string) {
              if (!SANDBOX_TEST.test(id.split("?")[0] ?? id)) return null;
              const reason = `skipped: needs the umbrella workspace (x207-labs/x207), missing here: ${missing.join(", ")}`;
              return `import { describe, it } from "vitest";\ndescribe.skip(${JSON.stringify(id.split(/[\\/]/).pop())}, () => { it(${JSON.stringify(reason)}, () => {}); });\n`;
            },
          },
        ],
  test: { env: { NEARAI_MODE: "mock", NEARAI_API_KEY: "" } },
});
