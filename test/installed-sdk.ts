// AG-053: a few tests need an @x207/core newer than the one on npm (`0.0.2` carries contract ABI 0.0.15; the workspace package carries 0.0.18 and is not published yet). Those
// tests skip, with the reason, when the installed core reports an older interface, and run in full inside the umbrella workspace, where the workspace core is linked.
import { ContractAbi } from "@x207/core";

export const NEEDED_ABI = "0.0.18";
export const INSTALLED_ABI: string = ContractAbi.X207_CIRCLE_ABI_VERSION;

const parts = (version: string): number[] => version.split(".").map((n) => Number.parseInt(n, 10) || 0);
function isOlder(version: string, than: string): boolean {
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** True when the installed `@x207/core` has an older interface than this repository's tests need. */
export const SDK_TOO_OLD = isOlder(INSTALLED_ABI, NEEDED_ABI);
export const SDK_TOO_OLD_REASON = `installed @x207/core has interface ${INSTALLED_ABI}, this test needs ${NEEDED_ABI}; inside the umbrella the workspace core is used`;
