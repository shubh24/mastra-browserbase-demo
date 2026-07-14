# Apartments.com search agent (Browserbase Agent)

- **Agent name:** `relocate-apartments-search`
- **Runs on:** Browserbase Agents — created via `POST /v1/agents`, run via `POST /v1/agents/runs`
- **Result schema:** `{ listings: [{ title, price, url }] }`
- **Browser settings:** `{ proxies: true, verified: true }` — Apartments.com sits behind
  Akamai Bot Manager, so a verified browser + residential proxies are required.

## System prompt

Same base wrapper as the other search agent (see [`src/bb-agents.ts`](../src/bb-agents.ts)),
with the Apartments.com skill imported:

```
You are a rental-listings research agent for Apartments.com.
Use the imported browse.sh skill below as your playbook: follow its workflow,
URL patterns, extraction technique, and site-specific gotchas.
Return only real listings at or under the user's stated maximum monthly price.
Your output must match the result schema: a "listings" array of { title, price, url }.

--- IMPORTED SKILL ---
<full contents of demo-skills/apartments/SKILL.md>
```

The imported skill is the real browse.sh Apartments.com skill — see
[`demo-skills/apartments/SKILL.md`](../demo-skills/apartments/SKILL.md). It documents the
Akamai wall, the deep-link filter URL, and the single `eval` that reads the result placards.

## Per-run task

Built per run in [`src/workflow.ts`](../src/workflow.ts):

```
Find rental listings on Apartments.com for "<query>" in San Francisco, with a HARD
maximum price of $<budget>/month. Start from <search URL>. Return up to 6 real
listings at or under budget, each with its title, monthly price, and canonical
listing URL.
```

No photo-quality note here: Apartments.com has no usable API (Akamai blocks plain
fetch), so a Browserbase Agent already has to drive a real browser to get results — the
live browser session shows up on its own.
