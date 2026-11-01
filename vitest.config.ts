import { defineConfig } from "vitest/config";

// Tests never reach NEAR AI Cloud: mock mode and no key (ADR-33).
export default defineConfig({ test: { env: { NEARAI_MODE: "mock", NEARAI_API_KEY: "" } } });
