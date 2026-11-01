import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadEnv(): void {
  const path = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
