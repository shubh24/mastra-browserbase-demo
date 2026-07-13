/**
 * ────────────────────────────────────────────────────────────────────────────
 *  Browserbase Agents API client  ·  drives the SEARCH agents
 * ────────────────────────────────────────────────────────────────────────────
 *
 * On this branch the two search agents (Craigslist, Apartments.com) are NOT
 * Mastra agents driven through the browse CLI. They are **Browserbase Agents** —
 * the agent runs entirely on the Browserbase platform (Stagehand browser + web
 * search + sandboxed tools), and we drive it over the REST API:
 *
 *     POST /agents            create a reusable agent (skill baked into the prompt)
 *     POST /agents/runs       start a run
 *     GET  /agents/runs/{id}  poll status + structured result
 *     GET  /agents/runs/{id}/messages   stream the step-by-step transcript
 *
 * The apply step stays a Mastra agent, so the redaction/vault story still shows
 * in the Mastra trace. This module is the whole Browserbase-platform surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'https://api.browserbase.com/v1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function apiKey(): string {
  const k = process.env.BROWSERBASE_API_KEY;
  if (!k) throw new Error('BROWSERBASE_API_KEY is not set');
  return k;
}

async function bb(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-bb-api-key': apiKey(),
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Browserbase ${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── skills ──────────────────────────────────────────────────────────────────
/** Load a browse.sh SKILL.md so it can be baked into the agent's system prompt. */
export function loadSkill(name: string): string {
  return readFileSync(join(ROOT, 'demo-skills', name, 'SKILL.md'), 'utf8');
}

// ── result schema shared by both search agents ───────────────────────────────
const LISTINGS_SCHEMA = {
  type: 'object',
  properties: {
    listings: {
      type: 'array',
      description: 'rental listings at or under the given budget',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          price: { type: 'string', description: 'monthly rent, e.g. "$2,450"' },
          url: { type: 'string', description: 'canonical listing URL' },
        },
        required: ['title', 'price', 'url'],
      },
    },
  },
  required: ['listings'],
} as const;

// ── agent CRUD ────────────────────────────────────────────────────────────────
const idCache = new Map<string, string>();

/**
 * Idempotently create (or find, by name) a Browserbase agent with the given
 * skill baked into its system prompt. Returns the agentId. Safe to call every
 * run — it caches in-process and reuses the same agent across runs.
 */
export async function ensureAgent(opts: {
  name: string;
  skill: string;   // demo-skills folder name
  site: string;    // human site name for the prompt
}): Promise<string> {
  if (idCache.has(opts.name)) return idCache.get(opts.name)!;

  const systemPrompt =
    `You are a rental-listings research agent for ${opts.site}.\n` +
    `Use the imported browse.sh skill below as your playbook: follow its workflow, ` +
    `URL patterns, extraction technique, and site-specific gotchas exactly.\n` +
    `Return only real listings at or under the user's stated maximum monthly price. ` +
    `Your output must match the result schema: a "listings" array of { title, price, url }.\n\n` +
    `--- IMPORTED SKILL ---\n${loadSkill(opts.skill)}`;

  // find an existing agent by name (list is cursor-paginated; array under `data`)
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page$ = await bb(`/agents${q}`);
    const list: any[] = page$.data ?? page$.agents ?? page$.items ?? [];
    const found = list.find((a) => a.name === opts.name);
    if (found?.agentId) {
      idCache.set(opts.name, found.agentId);
      return found.agentId;
    }
    cursor = page$.nextCursor;
    if (!cursor) break;
  }

  // not found → create it
  const created = await bb('/agents', {
    method: 'POST',
    body: JSON.stringify({ name: opts.name, systemPrompt, resultSchema: LISTINGS_SCHEMA }),
  });
  idCache.set(opts.name, created.agentId);
  return created.agentId;
}

// ── runs ──────────────────────────────────────────────────────────────────────
export interface AgentRun {
  runId: string;
  agentId?: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'STOPPED';
  sessionId?: string;
  result?: { output?: any };
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'TIMED_OUT', 'STOPPED']);

async function startRun(body: Record<string, unknown>): Promise<AgentRun> {
  return bb('/agents/runs', { method: 'POST', body: JSON.stringify(body) });
}

async function getRun(runId: string): Promise<AgentRun> {
  return bb(`/agents/runs/${runId}`);
}

/** Live view + dashboard URL for the run's Browserbase session. */
async function sessionUrls(sessionId: string): Promise<{ liveViewUrl: string | null; sessionUrl: string }> {
  let liveViewUrl: string | null = null;
  try {
    const dbg = await bb(`/sessions/${sessionId}/debug`);
    liveViewUrl = dbg?.debuggerFullscreenUrl ?? dbg?.debuggerUrl ?? null;
  } catch {
    /* live view is best-effort */
  }
  return { liveViewUrl, sessionUrl: `https://browserbase.com/sessions/${sessionId}` };
}

/**
 * Extract readable text from a run message. The API returns entries shaped like
 * `{ message: { role, content: [{ type, text | toolName }] } }` (AI-SDK style).
 */
function messageText(message: any): string {
  const parts = message?.content ?? message?.parts ?? [];
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const p of parts) {
    if ((p?.type === 'text' || p?.type === 'reasoning') && typeof p.text === 'string' && p.text.trim()) {
      out.push(p.text.trim());
    } else if (typeof p?.type === 'string' && p.type.includes('tool') && p.toolName) {
      out.push(`🔧 ${p.toolName}`);
    }
  }
  return out.join(' ');
}

/**
 * Start a search-agent run and drive it to completion:
 *   - onSession fires once, as soon as the run's browser session exists
 *     (so the UI can embed the live view)
 *   - onMessage streams the agent's transcript lines into the activity feed
 * Returns the structured { listings } payload (empty on failure/timeout).
 */
export async function runSearchAgent(opts: {
  agentId: string;
  task: string;
  browserSettings?: Record<string, unknown>;
  onSession?: (s: { sessionId: string; liveViewUrl: string | null; sessionUrl: string }) => void;
  onMessage?: (text: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ listings: Array<{ title: string; price: string; url: string }>; sessionId: string | null; status: string }> {
  const { agentId, task, browserSettings, onSession, onMessage } = opts;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 3_000;

  const started = await startRun({
    agentId,
    task,
    resultSchema: LISTINGS_SCHEMA,
    ...(browserSettings ? { browserSettings } : {}),
  });
  const runId = started.runId;

  let sessionShown = false;
  let since: string | undefined;
  let sessionId: string | null = started.sessionId ?? null;
  const deadline = Date.now() + timeoutMs;

  let run: AgentRun = started;
  while (Date.now() < deadline) {
    run = await getRun(runId).catch(() => run);
    sessionId = run.sessionId ?? sessionId;

    if (sessionId && !sessionShown) {
      const urls = await sessionUrls(sessionId);
      onSession?.({ sessionId, ...urls });
      sessionShown = true;
    }

    // stream transcript (best-effort, never fatal)
    if (onMessage) {
      try {
        const q = since ? `?since=${encodeURIComponent(since)}` : '';
        const data = await bb(`/agents/runs/${runId}/messages${q}`);
        for (const entry of data.data ?? data.messages ?? []) {
          const message = entry.message ?? entry;
          if (message.role === 'assistant') {
            const t = messageText(message);
            if (t) onMessage(t);
          }
        }
        since = data.nextSince ?? since;
      } catch {
        /* transcript streaming is optional */
      }
    }

    if (TERMINAL.has(run.status)) break;
    await delay(pollMs);
  }

  const output = run.result?.output ?? {};
  const listings = Array.isArray(output.listings) ? output.listings : [];
  return { listings, sessionId, status: run.status };
}
