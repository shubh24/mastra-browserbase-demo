/**
 * The single tool the agents use: the whole browse CLI.
 *
 * Instead of a handful of typed wrappers (snapshot / click / fill / read), we
 * hand the agent the ENTIRE browse CLI through one `browse` tool. It decides
 * which subcommand to run — open, snapshot, click, fill, eval, get, wait,
 * press, select, … — exactly as documented in the imported browse.sh SKILL.md.
 *
 * PII architecture (bidirectional vault boundary) is enforced HERE, once:
 *   - a `fill` whose value contains a vault token (e.g. {{vault.ssn}}) has the
 *     real secret substituted at the wire; the model and the audit log only
 *     ever see the token.
 *   - every command's OUTPUT is re-masked, so a secret the page echoes back
 *     (snapshot, get value, eval) becomes its token again before the model sees it.
 *
 * The live BrowseSession + Vault for a run live in a module-level registry keyed
 * by an opaque runKey (+ session label for parallel browsers). Only those
 * strings travel through requestContext — the objects (and the secrets in the
 * vault) never serialize into workflow data or observability spans.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BrowseSession } from './browse-cli.js';
import type { Vault } from './pii.js';

interface RunResources {
  /** named sessions: 'craigslist' | 'apartments' | 'apply' — parallel browsers */
  sessions: Map<string, BrowseSession>;
  vault: Vault;
}

const registry = new Map<string, RunResources>();

export function registerRun(runKey: string, vault: Vault): RunResources {
  const r: RunResources = { sessions: new Map(), vault };
  registry.set(runKey, r);
  return r;
}

export function releaseRun(runKey: string): void {
  registry.delete(runKey);
}

export function getRunResources(runKey: string): RunResources | undefined {
  return registry.get(runKey);
}

function resources(ctx: any): { session: BrowseSession; vault: Vault } {
  const runKey = ctx?.requestContext?.get?.('runKey');
  const label = ctx?.requestContext?.get?.('sessionLabel');
  const r = runKey && registry.get(runKey);
  const session = r && label ? r.sessions.get(label) : undefined;
  if (!r || !session) throw new Error(`no browser session "${label}" registered for this run`);
  return { session, vault: r.vault };
}

const OUTPUT_LIMIT = 16000;

export const browseTool = createTool({
  id: 'browse',
  description:
    'Run any browse CLI command against the browser session that is already open for this task. ' +
    'Pass the command as an array of arguments (omit the leading "browse" and the "-s <session>" flag — ' +
    'those are added for you). Common commands:\n' +
    '  ["open","<url>"]                 navigate the tab\n' +
    '  ["snapshot"]                     accessibility tree with refs like @1-23\n' +
    '  ["click","<ref|selector>"]       click an element\n' +
    '  ["fill","<ref|selector>","<v>"]  fill an input (pass vault tokens like {{vault.ssn}} verbatim)\n' +
    '  ["get","text","body"]            read visible text; also: get html <sel>, get title, get url, get value <sel>\n' +
    '  ["eval","<js>"]                  run JS in the page and return the result (great for scraping result cards)\n' +
    '  ["wait","load"] / ["wait","timeout","3000"] / ["press","Enter"] / ["reload"] / ["select","<sel>","<v>"]\n' +
    'One command per call. Snapshot again after anything that changes the page.',
  inputSchema: z.object({
    args: z.array(z.string()).min(1).describe('browse CLI argument vector, e.g. ["snapshot"] or ["fill","@1-2","{{vault.ssn}}"]'),
  }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (input, ctx) => {
    const { session, vault } = resources(ctx);
    const args = input.args;

    // secret boundary: resolve vault tokens ONLY in the exec copy; the audit
    // log / feed keep the token form.
    const execArgs = args.map((a) => (/\{\{vault\./.test(a) ? vault.resolve(a) : a));
    const logAs = args.slice(1).join(' ');

    const out = await session.exec(execArgs, logAs);

    // bidirectional mask: re-tokenize any real secret before the model sees output
    let text = typeof out === 'string' ? out : JSON.stringify(out);
    text = vault.mask(text);
    if (text.length > OUTPUT_LIMIT) text = text.slice(0, OUTPUT_LIMIT) + '\n…(truncated)';
    return { result: text };
  },
});
