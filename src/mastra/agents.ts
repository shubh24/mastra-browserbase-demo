/**
 * The two relocate.ai agents that live inside the concierge workflow.
 *
 *   find-apartments-agent : discovery — operates a real listing site through
 *                           the browse CLI, guided by an imported browse.sh
 *                           SKILL.md (the site's quirks, captured once).
 *   apply-to-apartment    : action — operates the landlord's application portal
 *                           through the same browse CLI.
 *
 * Both get the ENTIRE browse CLI as a single tool and decide which subcommands
 * to run. Both are registered on the Mastra instance, so Studio shows them
 * under Agents and every model call is traced (and PII-redacted).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { browseTool } from '../tools.js';

const MODEL = process.env.CONCIERGE_MODEL || 'anthropic/claude-opus-4-8';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Storage-backed memory shared by the agents. This persists each conversation
 * as a thread (so Studio's Memory tab works, and support can review past runs)
 * and gives the agent the last N turns of context. semanticRecall/workingMemory
 * are off to keep the browser agents' tool loop lean.
 */
const memory = new Memory({
  storage: new LibSQLStore({ id: 'agent-memory', url: `file:${join(ROOT, 'mastra.db')}` }),
  options: {
    lastMessages: 20,
    semanticRecall: false,
    workingMemory: { enabled: false },
  },
});

/**
 * The imported browse.sh website skills, as NATIVE Mastra skills. Each folder
 * under demo-skills/ holds a SKILL.md (Craigslist, Apartments.com). Mastra's
 * SkillsProcessor lists them to the model and exposes a `skill` tool to load
 * the full instructions on demand — and they show up in Studio's Skills panel.
 * This is literally "importing websites as skills."
 */
const skillsWorkspace = new Workspace({
  filesystem: new LocalFilesystem({ basePath: ROOT }),
  skills: ['demo-skills'],
});

export const findApartmentsAgent = new Agent({
  id: 'find-apartments-agent',
  name: 'Find Apartments Agent',
  description: 'Discovery agent: operates a real listings site (Craigslist / Apartments.com) via the browse CLI, guided by an imported browse.sh skill, and returns a within-budget shortlist.',
  model: MODEL,
  instructions: `You are the apartment-discovery agent for relocate.ai, a relocation concierge.

A browser session is ALREADY OPEN on a real apartment-listings site. Your task prompt
includes an imported browse.sh SKILL.md for that exact site — its recommended workflow,
selectors, and gotchas. Treat that skill as ground truth for how the site behaves.

You have one tool: "browse" — the whole browse CLI. Call it with an argument array, one
command per call (e.g. ["snapshot"], ["eval","<js>"], ["get","html","body"]).

You also have imported website skills (Craigslist, Apartments.com). Your task names the
skill for the current site — load it with the skill tool and treat it as ground truth for
that site's workflow, selectors, and gotchas.

Rules:
- The session is already open on the results page. Extract the visible listings using the
  BROWSER (snapshot / eval / get html) so the work is watchable — do not fetch a raw API.
- Follow the skill's site-specific guidance and gotchas (bot walls, geo-scoping,
  which selectors carry price/beds). If the skill gives an extraction eval, use it.
- The budget is a HARD ceiling: parse numeric prices and only keep listings at or under it.
- Only real 1-bedroom-style apartments matching the request; skip rooms, spam, and ads.
- If the page shows a block/verification wall you cannot get past, return an empty list
  rather than inventing data.

Return the shortlist you extracted (title + monthly price), cheapest first.`,
  tools: { browseTool },
  workspace: skillsWorkspace,
  memory,
});

export const applyToApartmentAgent = new Agent({
  id: 'apply-to-apartment-agent',
  name: 'Apply To Apartment Agent',
  description: 'Action agent: fills and submits the rental application on the landlord portal via the browse CLI, using vault tokens so the SSN/email/phone never reach the model.',
  model: MODEL,
  instructions: `You are the application agent for relocate.ai. A browser session is already open
on the landlord's rental-application portal. Your job: complete and submit the rental
application on the customer's behalf.

You have one tool: "browse" — the whole browse CLI. Call it with an argument array, one
command per call. ONE action at a time — never issue two browse calls in one turn; the
browser types into the focused element, so parallel fills interleave keystrokes and
corrupt the form.

How to operate:
1. Start with ["snapshot"] to see the page. Elements carry refs like @1-123.
2. ["click","@ref"] / ["fill","@ref","<value>"] with those refs. Snapshot again after
   navigation or when a click reveals new content.
3. The portal may show a property picker first — select the property you were told to
   apply for. If it prompts to create an account, choose "Skip for now" (guest flow).
4. Fill every REQUIRED field. Non-sensitive customer data is in your task prompt.
5. SENSITIVE fields (SSN, email, phone) are given ONLY as vault tokens like {{vault.ssn}}.
   Pass the token verbatim as the fill value — the real secret is substituted at the wire
   and you never see it. When you read the page back, a filled secret shows as its token;
   that means the field is correct. NEVER invent or ask for the underlying value.
6. Accept the terms, type the signature as the customer's full name, submit, then
   ["get","text","body"] to confirm the outcome and report what the confirmation said.

Large forms have many sections (applicant info, rental history, employment, terms). Work
top to bottom. If a fill fails, snapshot and use the correct ref.`,
  tools: { browseTool },
  memory,
});
