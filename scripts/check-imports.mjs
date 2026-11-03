#!/usr/bin/env node
// AG-006: kode agent hanya boleh memakai paket publik x207/x402 (@x402/fetch, @x207/scheme, @x207/core)
// dan berkas di repo ini. Import ke path internal paket atau kode repo lain gagal. Dependency pihak ketiga
// non-x207 tidak dilarang (K-48). Folder `test/` dikecualikan: test boleh memakai harness repo lain.
//
// Pakai: node scripts/check-imports.mjs   (exit 1 bila ada pelanggaran)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DIRS = ["shared", "agents", "onboarding", "scenario"];
const PUBLIC = new Set(["@x402/fetch", "@x207/scheme", "@x207/core", "@x207/core/signer"]);
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") yield* sourceFiles(path);
    } else if (/\.(ts|mts|js|mjs)$/.test(name)) yield path;
  }
}

/** Daftar pelanggaran `{ file, specifier, reason }` di bawah `root`. */
export function findViolations(rootDir) {
  const root = resolve(rootDir);
  const violations = [];
  for (const dirName of DIRS) {
    const dir = join(root, dirName);
    try {
      statSync(dir);
    } catch {
      continue;
    }
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1];
        const where = relative(root, file);
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (target !== root && !target.startsWith(root + sep)) {
            violations.push({ file: where, specifier, reason: "relative import leaves the agents repo" });
          }
          continue;
        }
        if (specifier.startsWith("@x207/") || specifier.startsWith("@x402/")) {
          if (!PUBLIC.has(specifier)) {
            violations.push({ file: where, specifier, reason: "not a public package (@x402/fetch, @x207/scheme, @x207/core)" });
          }
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = findViolations(root);
  for (const v of violations) console.error(`${v.file}: import "${v.specifier}" dilarang: ${v.reason}`);
  if (violations.length > 0) process.exit(1);
  console.log("agents imports use public packages only");
}
