import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

describe("AG-007 agent tidak mengirim transaksi berdeposit", () => {
  it("TC-AG-007-02 review kode: folder agent, shared, dan scenario tidak mengirim transaksi atau memakai deposit", () => {
    const offenders: string[] = [];
    for (const dir of ["agents", "shared", "scenario"]) {
      for (const file of files(join(root, dir))) {
        const text = readFileSync(file, "utf8");
        if (/\bdeposit\b|createNearSender|signAndSend|callFunction|sendTransaction|ft_transfer_call/.test(text)) offenders.push(file.slice(root.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("TC-AG-007-03 stake dikirim lewat onboarding yang ditandatangani kunci pemilik, bukan kunci voucher", () => {
    const run = readFileSync(join(root, "onboarding/run.ts"), "utf8");
    expect(run).toMatch(/createNearSender\(\{ rpcUrl, accountId, secretKey: ownerKey\(accountId\) \}\)/);
    expect(run).not.toMatch(/voucherSecretKey/);
  });
});
