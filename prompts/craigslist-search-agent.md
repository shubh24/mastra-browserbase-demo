# Craigslist search agent (Browserbase Agent)

- **Agent name:** `relocate-craigslist-search`
- **Runs on:** Browserbase Agents — created via `POST /v1/agents`, run via `POST /v1/agents/runs`
- **Result schema:** `{ listings: [{ title, price, url }] }`
- **Browser settings:** platform default (no proxies / verified needed)

## System prompt

Assembled in [`src/bb-agents.ts`](../src/bb-agents.ts) (`ensureAgent`) as a small base
wrapper followed by the imported skill:

```
You are a rental-listings research agent for Craigslist.
Use the imported browse.sh skill below as your playbook: follow its workflow,
URL patterns, extraction technique, and site-specific gotchas.
Return only real listings at or under the user's stated maximum monthly price.
Your output must match the result schema: a "listings" array of { title, price, url }.

--- IMPORTED SKILL ---
<full contents of demo-skills/craigslist/SKILL.md>
```

The imported skill is the real browse.sh Craigslist skill — see
[`demo-skills/craigslist/SKILL.md`](../demo-skills/craigslist/SKILL.md). This is
literally "importing a website as a skill": the site's workflow and gotchas, captured
once, handed to the agent.

## Per-run task

Built per run in [`src/workflow.ts`](../src/workflow.ts):

```
Find rental listings on Craigslist for "<query>" in San Francisco, with a HARD
maximum price of $<budget>/month. Start from <search URL>. Return up to 6 real
listings at or under budget, each with its title, monthly price, and canonical
listing URL. <photo-quality note>
```

### The photo-quality note (why Craigslist opens a real browser)

```
IMPORTANT: quality of the listing PHOTO matters. You must actually LOOK AT each
listing's primary image and only include listings whose photo looks good and clear —
exclude listings with no photo or a blurry/low-quality photo. Open the listings in
the browser and view the images to judge.
```

Craigslist has a public JSON API, and a Browserbase Agent will use it by default (it's
cheaper and faster). That means no visible browser. This note requires **visual** photo
judgment — something the API can't do — so the agent is forced onto a real browser
(navigate + screenshot + reason over the images), which is exactly what we want to show
in the demo. It's also a legitimate product requirement: only surface listings that
actually look good.
