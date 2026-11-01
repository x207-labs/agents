// Tumpukan lengkap di near-sandbox untuk test e2e agents: kontrak, enam agent ter-onboard, facilitator, dan enam server agent.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCircleViewFn, type ContractCall } from "@x207/core";
import { NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService } from "@x207/facilitator";
import { defineCircleConfig } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { onboardAgents } from "../onboarding/onboard.ts";
import { createAgentServer } from "../shared/agent-server.ts";
import type { AgentIdentity } from "../shared/identity.ts";
import { createNearAiClient } from "../shared/nearai.ts";
import { AGENT_NAMES, AGENTS, type AgentName } from "../shared/registry.ts";
import { createSellerPaywall } from "../shared/x207.ts";
import { serveWeb } from "./helpers.ts";

export type Stack = {
  fx: CircleFixture;
  identity: Record<AgentName, AgentIdentity>;
  urls: Record<AgentName, string>;
  pending: PendingStore;
  /** Respons `/settle` facilitator, urut waktu. */
  settled: unknown[];
  scheduler: RegistrationScheduler;
  facilitatorUrl: string;
  rpc: NearRpc;
  relayer: { accountId: string; secretKey: string };
  stop(): Promise<void>;
};

export async function startStack(): Promise<Stack> {
  const fx = await deployCircle();
  const keysDir = mkdtempSync(join(tmpdir(), "x207-stack-keys-"));
  const servers: Server[] = [];
  const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
  const accounts = await Promise.all(AGENT_NAMES.map((name) => fx.member(name)));
  const outcomes = await onboardAgents({
    agents: accounts.map((account) => ({
      accountId: account.accountId,
      sendCall: async (call: ContractCall) => {
        const result = await account.call(call);
        if (result.failures.length > 0) throw new Error(result.failures.join("; "));
        return result.value;
      },
    })),
    circleContract: fx.circle.accountId, circleId: fx.circleId, termsHash: TERMS_HASH, stakeAmount: "50000000",
    policy: { maxPerCall: "100000", maxPerEpoch: "50000000" }, view, keysDir, network: "sandbox",
    usdtTokenId: fx.usdt.accountId, pollIntervalMs: 200, timeoutMs: 30_000,
  });
  const identity = Object.fromEntries(outcomes.map((o, i) => [AGENT_NAMES[i], o.identity])) as Record<AgentName, AgentIdentity>;

  const relayer = await fx.sandbox.createAccount("relayer", "20");
  const pending = new PendingStore(":memory:");
  const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
  const circle = defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId });
  const app = createApp(createFacilitatorService({ circles: [circle], rpc, pending, signers: [relayer.accountId] }));
  const settled: unknown[] = [];
  const facilitator = await serveWeb(async (request) => {
    const response = await app.fetch(request);
    if (new URL(request.url).pathname === "/settle") settled.push(await response.clone().json());
    return response;
  });
  servers.push(facilitator.server);

  const urls = {} as Record<AgentName, string>;
  for (const name of AGENT_NAMES) {
    const spec = AGENTS[name];
    const paywall = createSellerPaywall(spec, { facilitatorUrl: facilitator.url, circleId: fx.circleId, payTo: identity[name].accountId });
    const server = createAgentServer(spec, createNearAiClient({ agent: name }), paywall);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    urls[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const scheduler = new RegistrationScheduler({
    circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
    chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
  });
  return {
    fx, identity, urls, pending, settled, scheduler, facilitatorUrl: facilitator.url, rpc,
    relayer: { accountId: relayer.accountId, secretKey: relayer.secretKey },
    async stop() {
      servers.forEach((s) => s.closeAllConnections?.() ?? s.close());
      rmSync(keysDir, { recursive: true, force: true });
      await fx.stop();
    },
  };
}
