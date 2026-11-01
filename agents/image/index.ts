import { startAgent } from "../../shared/agent-server.ts";
import { AGENTS } from "../../shared/registry.ts";

startAgent(AGENTS.image);
