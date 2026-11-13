// @vitest-environment node
// SD-078: the agents repository is English. The scan reads every file under agents, config, onboarding, scenario, scripts, shared, test, README.md, docs (source and tests and the documents), drops the comments of the code, and fails on a common Indonesian word. Error codes
// are not touched by this item. A word that is also English or a name is not in the list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const ROOTS: readonly string[] = ["agents", "config", "onboarding", "scenario", "scripts", "shared", "test", "README.md", "docs"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "target", "python", "coverage"]);
const SKIP_FILES = new Set(["english.test.ts"]);
const WORDS = [
  "dengan", "yang", "tidak", "untuk", "dari", "sudah", "belum", "atau", "dan", "harus", "bukan", "karena", "sebelum", "setelah", "adalah", "dapat", "akan", "pada", "jika", "bila",
  "saat", "gagal", "berhasil", "kunci", "penjual", "pembeli", "jendela", "anggota", "kontrak", "lisensi", "pesanan", "kode", "sengketa", "penerbit", "jaminan", "tonggak", "penawaran",
  "batas", "nilai", "simpan", "hapus", "kirim", "unduh", "periksa", "siapkan", "tagihan", "bayar", "dibayar", "ditolak", "dikirim", "pengguna", "akun", "diperlukan", "salah", "benar",
];
const PATTERN = new RegExp(`(?<![A-Za-z_])(${WORDS.join("|")})(?![A-Za-z_])`, "i");
// AG-053: names of agent accounts on testnet that contain a listed word ("dan", "and"): the ring member `dan2` of the barter demo (`dan2.x207-v18-own.testnet`) and `dan3` of the
// overspend run it cites. They are removed before the scan, as whole names only; the word itself is still found everywhere else.
const AGENT_NAMES: readonly string[] = ["dan2", "dan3"];
const NAMES = new RegExp(`(?<![A-Za-z0-9_])(${AGENT_NAMES.join("|")})(?![A-Za-z0-9_])`, "g");

function files(dir: string): string[] {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (stat?.isFile()) return [dir];
  if (!stat?.isDirectory()) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(path);
    return /\.(ts|tsx|mjs|js|md)$/.test(name) && !SKIP_FILES.has(name) ? [path] : [];
  });
}
const withoutComments = (path: string, text: string): string =>
  path.endsWith(".md")
    ? text
    : text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, "$1"))
        .join("\n");

describe("SD-078 the agents repository is in English", () => {
  it("TC-SD-078-02 no file has a common Indonesian word outside the comments", () => {
    const found: string[] = [];
    for (const r of ROOTS) {
      for (const path of files(join(root, r))) {
        withoutComments(path, readFileSync(path, "utf8")).split("\n").forEach((line, i) => {
          const m = PATTERN.exec(line.replace(NAMES, " "));
          if (m) found.push(`${path.slice(root.length + 1)}:${i + 1}: "${m[1]}" in ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(found.slice(0, 40)).toEqual([]);
  });
});
