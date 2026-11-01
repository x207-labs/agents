import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error skrip .mjs tanpa tipe
import { findViolations } from "../scripts/check-imports.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "x207-imports-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("AG-006 pemeriksaan import", () => {
  it("TC-AG-006-01 repo agents saat ini lulus", () => {
    expect(findViolations(repo)).toEqual([]);
  });

  it("TC-AG-006-02 import ke path internal paket gagal dan pesan menyebut file serta import", () => {
    const root = fixture({
      "shared/a.ts": 'import { x } from "@x207/scheme/src/client/index";\nimport { y } from "@x207/core/dist/voucher.js";\n',
    });
    const violations = findViolations(root);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({ file: join("shared", "a.ts"), specifier: "@x207/scheme/src/client/index" });
  });

  it("TC-AG-006-03 import relatif ke kode repo lain gagal", () => {
    const root = fixture({ "agents/a/index.ts": 'import { z } from "../../../sdk/packages/core/src/index.ts";\nimport("../../x.ts");\n' });
    const violations = findViolations(root);
    expect(violations.map((v: { specifier: string }) => v.specifier)).toEqual(["../../../sdk/packages/core/src/index.ts"]);
  });

  it("TC-AG-006-04 hanya import publik, node:, relatif dalam repo, dan pihak ketiga lulus", () => {
    const root = fixture({
      "shared/ok.ts":
        'import { createServer } from "node:http";\nimport { wrapFetchWithPayment } from "@x402/fetch";\nimport { x207Middleware } from "@x207/scheme";\n' +
        'import { onboardMember } from "@x207/core";\nimport { createNearSender } from "@x207/core/signer";\nimport local from "./local.ts";\nimport lib from "some-lib";\n',
      "shared/local.ts": "export default 1;\n",
      "test/skip.ts": 'import x from "../../sdk/anything";\n',
    });
    expect(findViolations(root)).toEqual([]);
  });
});
