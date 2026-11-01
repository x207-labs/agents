export const AGENT_NAMES = ["translator", "summarizer", "scraper", "image", "cleaner", "gpu"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export type AgentSpec = {
  name: AgentName;
  port: number;
};

export const AGENTS: Record<AgentName, AgentSpec> = {
  translator: { name: "translator", port: 4201 },
  summarizer: { name: "summarizer", port: 4202 },
  scraper: { name: "scraper", port: 4203 },
  image: { name: "image", port: 4204 },
  cleaner: { name: "cleaner", port: 4205 },
  gpu: { name: "gpu", port: 4206 },
};
