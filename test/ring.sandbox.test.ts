// AG-005 di near-sandbox: enam agent dalam cincin saling membeli dan menjual lewat x207, kontrak nyata.
// Jalankan dengan X207_SANDBOX=1 (npm run test:sandbox); harness di sdk/test-support.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFetchWithPayment } from "@x402/fetch";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, generateVoucherKeypair, type ContractCall } from "@x207/core";
import { NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService } from "@x207/facilitator";
import { X207PaymentClient, defineCircleConfig } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../sdk/test-support/circle.ts";
import { sandboxAvailable } from "../../sdk/test-support/sandbox.ts";
import { onboardAgents } from "../onboarding/onboard.ts";
import { createAgentServer } from "../shared/agent-server.ts";
import { createNearAiClient } from "../shared/nearai.ts";
import { AGENT_NAMES, AGENTS, type AgentName } from "../shared/registry.ts";
import { createAgentBuyer, createSellerPaywall } from "../shared/x207.ts";
import { serveWeb } from "./helpers.ts";

const decode = (header: string | null) => JSON.parse(Buffer.from(header!, "base64").toString("utf8"));

describe.skipIf(!sandboxAvailable)("AG-005 cincin enam agent di near-sandbox", () => {
  let fx: CircleFixture;
  const servers: Server[] = [];
  const keysDir = mkdtempSync(join(tmpdir(), "x207-ring-keys-"));
  afterAll(async () => {
    servers.forEach((s) => s.closeAllConnections?.() ?? s.close());
    rmSync(keysDir, { recursive: true, force: true });
    await fx?.stop();
  });

  it("TC-AG-005-01..09, 11 cincin translator -> summarizer -> ... -> gpu -> translator", async () => {
    fx = await deployCircle();
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
    const identity = Object.fromEntries(outcomes.map((o, i) => [AGENT_NAMES[i], o.identity])) as Record<AgentName, (typeof outcomes)[number]["identity"]>;

    // Facilitator nyata di atas kontrak sandbox; respons /settle direkam untuk TC-AG-005-09.
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

    // TC-AG-005-01: tanpa header pembayaran -> 402 dengan dua entri
    const challenge = await fetch(`${urls.summarizer}/api/summarize?input=halo`);
    expect(challenge.status).toBe(402);
    const required = decode(challenge.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts.map((a: { scheme: string; network: string }) => `${a.scheme}@${a.network}`)).toEqual([
      "batch-settlement@x207:agents-main", "exact@near:mainnet",
    ]);

    // TC-AG-005-02..08: tiap agent membeli dari agent berikutnya di cincin
    const ring = AGENT_NAMES.map((name, i) => [name, AGENT_NAMES[(i + 1) % AGENT_NAMES.length]!] as const);
    for (const [buyer, seller] of ring) {
      const paid = createAgentBuyer(identity[buyer], { rpcUrls: [fx.sandbox.rpcUrl] });
      const response = await paid(`${urls[seller]}/api/${AGENTS[seller].verb}?input=halo`);
      expect(response.status, `${buyer} -> ${seller}`).toBe(200);
      expect(await response.json()).toMatchObject({ agent: seller });
      const header = decode(response.headers.get("PAYMENT-RESPONSE"));
      expect(header).toMatchObject({ success: true, extensions: { x207: { seq: 1 } } });
      // TC-AG-005-09: header penjual identik dengan respons /settle facilitator untuk panggilan itu
      expect(header).toEqual(settled.at(-1));
    }
    expect(settled).toHaveLength(6);

    // Registrasi on-chain lalu graf kewajiban: enam edge cincin
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 6, retrying: 0, dropped: 0 });
    const epoch = (await fx.sandbox.view<{ epoch: number }>(fx.circle.accountId, "get_epoch", {})).epoch;
    for (const [buyer, seller] of ring) {
      const edge = await fx.sandbox.view<{ cumulative: string }>(fx.circle.accountId, "obligation", {
        epoch, debtor: identity[buyer].accountId, creditor: identity[seller].accountId,
      });
      expect(edge.cumulative, `${buyer} -> ${seller}`).toBe("20000");
    }

    // TC-AG-005-11: non-anggota membayar dengan voucher x207 -> 402 member_not_found, entri exact tetap diiklankan
    const outsider = await fx.member("outsider");
    const keys = generateVoucherKeypair();
    const client = new X207PaymentClient({ payer: outsider.accountId, secretKey: keys.secretKey, headroom: async () => "1000000" });
    const rejected = await wrapFetchWithPayment(fetch, client)(`${urls.gpu}/api/compute?input=halo`);
    expect(rejected.status).toBe(402);
    const body = decode(rejected.headers.get("PAYMENT-REQUIRED"));
    expect(body.error).toBe("member_not_found");
    expect(body.accepts.some((a: { scheme: string }) => a.scheme === "exact")).toBe(true);
  }, 600_000);
});
