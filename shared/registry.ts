export const AGENT_NAMES = ["translator", "summarizer", "scraper", "image", "cleaner", "gpu"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export type AgentSpec = {
  name: AgentName;
  port: number;
  /** Route served at GET /api/<verb>?input=... */
  verb: string;
  /** System prompt sent to NEAR AI Cloud. */
  system: string;
};

export const AGENTS: Record<AgentName, AgentSpec> = {
  translator: {
    name: "translator",
    port: 4201,
    verb: "translate",
    system: "You are a translator agent. Translate the user's text to English. Reply with the translation only.",
  },
  summarizer: {
    name: "summarizer",
    port: 4202,
    verb: "summarize",
    system: "You are a summarizer agent. Summarize the user's text in at most two sentences.",
  },
  scraper: {
    name: "scraper",
    port: 4203,
    verb: "scrape",
    system: "You are a scraper agent. Extract the key facts from the user's text as a short bullet list.",
  },
  image: {
    name: "image",
    port: 4204,
    verb: "image",
    system: "You are an image agent. Write a one-sentence image prompt that depicts the user's text.",
  },
  cleaner: {
    name: "cleaner",
    port: 4205,
    verb: "clean",
    system: "You are a data cleaner agent. Fix typos and normalize whitespace in the user's text. Reply with the cleaned text only.",
  },
  gpu: {
    name: "gpu",
    port: 4206,
    verb: "compute",
    system: "You are a GPU compute agent. Describe in one sentence the compute job needed to process the user's request.",
  },
};
