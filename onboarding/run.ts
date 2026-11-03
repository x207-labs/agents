// CLI: `npm run agent -- onboarding/run.ts` dengan variabel di .env.example bagian Onboarding.
// Kunci pemilik dibaca dari <KEYS_DIR>/<NETWORK>/<akun>.json (format skrip akun payung); tidak ada rahasia dicetak.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNearSender, createNearView } from "@x207/core/signer";
import { AGENT_NAMES } from "../shared/registry.ts";
import { loadSpendPolicy } from "../shared/identity.ts";
import { onboardAgents } from "./onboard.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`variable ${name} is required`);
  return value;
};

const network = required("ONBOARD_NETWORK");
const rpcUrl = required("ONBOARD_RPC_URL");
const circleContract = required("CIRCLE_CONTRACT");
const keysDir = resolve(process.env.KEYS_DIR ?? ".keys");
const ownerKey = (accountId: string): `ed25519:${string}` =>
  JSON.parse(readFileSync(resolve(keysDir, network, `${accountId}.json`), "utf8")).secret_key;

const outcomes = await onboardAgents({
  agents: AGENT_NAMES.map((name) => {
    const accountId = `${name}.${circleContract}`;
    return { accountId, sendCall: createNearSender({ rpcUrl, accountId, secretKey: ownerKey(accountId) }) };
  }),
  circleContract,
  circleId: process.env.CIRCLE_ID ?? "agents-main",
  termsHash: required("TERMS_HASH"),
  stakeAmount: required("STAKE_AMOUNT"),
  policy: loadSpendPolicy(resolve(required("SPEND_POLICY_FILE"))),
  view: createNearView(rpcUrl, circleContract),
  keysDir,
  network,
  ...(process.env.USDT_TOKEN_ID ? { usdtTokenId: process.env.USDT_TOKEN_ID } : {}),
  log: console.log,
});
console.log(`${outcomes.length} agent siap`);
