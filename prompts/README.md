# Agent prompts

relocate.ai runs three agents. This folder documents the **exact system prompts and
task templates** each one receives, so you can see what's actually sent to the model —
without having to read through the orchestration code.

| Agent | Runs on | What it does |
|---|---|---|
| [`relocate-craigslist-search`](./craigslist-search-agent.md) | Browserbase Agents (platform) | Searches Craigslist for within-budget rentals |
| [`relocate-apartments-search`](./apartments-search-agent.md) | Browserbase Agents (platform) | Searches Apartments.com (verified browser + residential proxies) |
| [`apply-to-apartment-agent`](./apply-to-apartment-agent.md) | Mastra (in-process) | Fills + submits the rental application; PII stays out of the model via vault tokens |

## How the two kinds of agent differ

- **The two search agents are [Browserbase Agents](https://docs.browserbase.com/platform/agents/overview).**
  We create them via `POST /v1/agents` with a system prompt (a small base wrapper + an
  imported browse.sh `SKILL.md`) and run them via `POST /v1/agents/runs` with a per-run
  task. Browserbase runs the whole browser-agent loop; we just poll for the result. The
  client is in [`src/bb-agents.ts`](../src/bb-agents.ts).
- **The apply agent is a Mastra agent** running in-process, so its trace and PII
  redaction show up in Mastra Studio. It's defined in [`src/mastra/agents.ts`](../src/mastra/agents.ts).

## What is NOT in this repo (on purpose)

- The **Browserbase API key** and **Anthropic key** live in `.env` (git-ignored).
- The agents' **IDs** are assigned by Browserbase at creation time — we never hardcode
  them. Agents are found (or created) **by name** at runtime (`ensureAgent` in
  `src/bb-agents.ts`), so anyone can run this with their own account.
