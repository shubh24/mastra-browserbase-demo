# mastra-browserbase-demo

**relocate.ai** — a relocation concierge that imports websites as skills and runs them as durable, observable browser agents. Built with [Mastra](https://mastra.ai) + [Browserbase](https://browserbase.com).

One [Mastra](https://mastra.ai) workflow searches **Craigslist** and **Apartments.com** in parallel, pauses for the customer to approve, then fills and submits a rental application on a landlord portal — all in real [Browserbase](https://browserbase.com) cloud browsers, with the applicant's PII redacted from every trace and kept out of the model.

The two **search** agents run on the [Browserbase Agents](https://docs.browserbase.com/platform/agents/overview) platform (each with an imported [browse.sh](https://browse.sh) skill baked into its system prompt); the **apply** agent is a Mastra agent, so its trace and PII redaction show in Mastra Studio. The exact prompts each agent receives are documented in [`prompts/`](./prompts).

## What it shows

- **Importing websites as skills** — real browse.sh `SKILL.md` files (Craigslist, Apartments.com) become the search agents' playbooks.
- **Browserbase Agents** — the search runs on the Browserbase platform: one API call with a task + a skill, and Browserbase runs the whole browser-agent loop (live view + session replay included).
- **Deterministic + agentic together** — a Mastra workflow with parallel search branches, a validation loop, a deterministic match step, and a durable human-in-the-loop approval.
- **Two safety pillars** — Mastra's `SensitiveDataFilter` redacts PII from every span; a vault substitutes secrets (SSN/email/phone) only at the browser wire, so the model only ever sees `{{vault.ssn}}`-style tokens.
- **Observability** — every run is a replayable trace in Mastra Studio; each browser session has a live view and a session replay.

## Setup

```bash
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
```

You also need the Browserbase `browse` CLI on your PATH:

```bash
npm i -g browse
```

## Run it

```bash
npm run ui         # the relocate.ai product UI at http://localhost:4747
npm run concierge  # the same workflow from the terminal (dry-run runner)
npm run dev        # Mastra Studio — agents, workflows, and traces
```

## Layout

```
src/
  workflow.ts        the relocation-concierge workflow
  bb-agents.ts       Browserbase Agents API client (the two search agents)
  tools.ts           the single `browse` tool (the whole browse CLI)
  pii.ts             the Vault (secret substitution) + redaction helpers
  browse-cli.ts      thin wrapper around the Browserbase browse CLI
  server.ts          the demo UI server (start / approve / state / replay)
  demo-state.ts      in-process bridge from the workflow to the UI
  mastra/
    index.ts         the Mastra instance (agents, workflows, storage, observability)
    agents.ts        the apply-to-apartment agent (Mastra)
    learn.ts         four small teaching examples (agent, workflow, agent-in-workflow, HITL)
prompts/             documented system prompts + tasks for each agent
demo-skills/         imported browse.sh SKILL.md files (Craigslist, Apartments.com)
public/index.html    the relocate.ai UI
```

## Teaching examples

`src/mastra/learn.ts` registers four minimal, heavily-commented examples that build up the Mastra concepts (a bare agent, a deterministic workflow, an agent inside a workflow, and a suspend/resume human-in-the-loop workflow) — visible in Studio alongside the real demo.
