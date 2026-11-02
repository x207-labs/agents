# Credit circles and the NEAR AI Agent Market (study)

Status: a short study. Nothing is built and no integration was tried. Sources were read on 2026-11-02; what could not be verified is written as such.

## What the market is, as far as the sources say

| Fact | Source |
| --- | --- |
| A requester posts a task with a budget; agents send proposals with price and timeline; the requester picks one | [NEAR AI blog](https://near.ai/blog/introducing-near-ai-agent-market), announced 4 Feb 2026 |
| After a bid is selected the funds go into escrow; the agent does the work and submits the result with a verification hash; payment is in NEAR | same |
| Quality conflicts go to an "agentic dispute system" whose agent reviews the sides and rules; who runs it and how appeals work is not described | same |
| An agent enters the market by being told to read a skill file at `market.near.ai/skill.md`; the blog gives no registration form and no API documentation | same |
| The skill file itself could not be read: the fetch returned only the title and a tagline. How registration, authentication and payment work in detail is **not verified** | [market.near.ai/skill.md](https://market.near.ai/skill.md) |
| The blog mentions no reputation system. Search snippets of public job pages mention bid lists with reputation stars and statuses such as Rejected, Expired and Disputed; these come from job pages with spammy content and are **not verified** | search results |

## How an agent of the market would join a circle

1. The owner of the agent opens a NEAR account for it, creates a voucher key (a key that only signs vouchers, never an access key) and calls `join` with the terms hash of the circle, then stakes USDT (F1). The stake sets the credit limit.
2. The agent adds the x207 binding to its x402 client (`@x207/scheme`) so that it can pay a 402 with a voucher. Its seller side adds one entry to the `accepts` list of its endpoints.
3. The agent keeps working in the market as before. Inside a job it can buy help from other members of the circle with vouchers instead of paying each call (F2); at the end of the epoch debts that form cycles are cleared (F3) and only the net is settled in USDT (F4).

The useful case is a worker agent that **subcontracts** (translation, scraping, a GPU call) to other members while it does a job, many small purchases both ways. The market itself, with one escrowed payment per job, does not need a circle.

## Obstacles

| Obstacle | Why |
| --- | --- |
| Different money | The market pays in NEAR; a circle settles its residual in USDT (NEP-141). A worker would convert, or the circle would need a NEAR-denominated unit, which the contract does not have |
| Escrow against credit | The market holds the budget before the work; x207 extends credit against a stake. A requester cannot pay a job with credit from the circle unless the requester is a member and the worker accepts a voucher: the market does not support that, as far as the sources say |
| Identity | Joining needs a NEAR account with a stake and an owner who signs `join`. An agent that only holds a market profile has none of this |
| Capital | The stake locks USDT; a small agent may not want to lock money to save a few transfers |
| Density | Clearing removes little when payments form a star (one buyer, many sellers). A single worker that buys from many suppliers is a star unless the suppliers also buy from it (README, section 9) |
| Disputes | The market has a dispute agent for jobs; x207 judges no quality ([reputation-and-disputes.md](../../docs/reputation-and-disputes.md)). A circle between market agents would rely on the market for the job and on the circle for the money between workers |
| No documented API | Without API documentation or a readable skill file, any integration would rest on guesses |

## What could be done, in order of cost

1. Nothing built: a worker agent that is a circle member can already run inside the market, since the market does not care how the worker pays its suppliers. This needs no change on either side.
2. A scenario in `agents/scenario/` where a market-style worker subcontracts to circle members and the epoch nets the debts. It reuses the business and invoice blocks already built.
3. Talk to the market team about paying a job with a voucher or settling jobs in a circle. That is a conversation for the owner, not a task for code.

## Not covered

No call to the market was made. Fees, escrow rules, limits of the dispute system, and whether the market is open to agents outside the NEAR AI frameworks are unknown from the sources read.
