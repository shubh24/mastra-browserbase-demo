/**
 * Thin wrapper around the Browserbase `browse` CLI.
 *
 * Every browser action shells out to `browse <cmd> -s <session>`.
 *
 * Demo-critical properties that live here:
 *   - Per-user session isolation: each BrowseSession is a distinct named
 *     Browserbase cloud session. Cookies / storage never cross users.
 *   - Secret substitution boundary: fillSecret() resolves vault tokens to real
 *     plaintext HERE, at the wire, and nowhere upstream.
 *   - Live view: opening a remote session yields a Browserbase live-view URL
 *     so a human can watch the agent drive the browser in real time.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Vault } from './pii.js';

const exec = promisify(execFile);

/**
 * Resolve the REAL browse CLI (v0.9.x).
 *
 * Gotcha: when this runs under tsx/npm, `node_modules/.bin` is prepended to
 * PATH, and a transitive dep ships an ancient `browse@0.2.0-alpha` that shadows
 * the global one and lacks `--remote`. So we pin an absolute path rather than
 * trusting bare `browse` on PATH. Override with BROWSE_BIN if needed.
 */
const BROWSE_BIN = (() => {
  if (process.env.BROWSE_BIN && existsSync(process.env.BROWSE_BIN)) return process.env.BROWSE_BIN;
  const known = `${process.env.HOME}/.nvm/versions/node/v24.11.1/bin/browse`;
  return existsSync(known) ? known : 'browse';
})();

async function browse(args: string[]): Promise<any> {
  const { stdout } = await exec(BROWSE_BIN, args, {
    env: process.env,
    maxBuffer: 1024 * 1024 * 16,
  });
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

export class BrowseSession {
  /** the audit log of browser actions — already token-safe, and it lands in
   *  the workflow trace so support can replay exactly what the agent did. */
  readonly actions: Array<{ cmd: string; arg?: string }> = [];

  /** serialize ALL commands for this session: the CLI types into the focused
   *  element, so two concurrent fills would interleave keystrokes across
   *  fields. Models love parallel tool calls — this makes that safe. */
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Browserbase session replay/inspector URL (for the dashboard). */
  sessionUrl: string | null = null;
  /** Live view URL — open this next to the terminal during the demo. */
  liveViewUrl: string | null = null;
  /** Browserbase session id (for the replay API). */
  sessionId: string | null = null;

  /** Optional observer — the demo UI streams these as the activity feed. */
  onAction: ((a: { cmd: string; arg?: string }) => void) | null = null;

  private constructor(public readonly name: string) {}

  private record(a: { cmd: string; arg?: string }): void {
    this.actions.push(a);
    try { this.onAction?.(a); } catch { /* feed is best-effort */ }
  }

  /** One isolated cloud session per user/run (or per site, for parallel search). */
  static async openIsolated(
    name: string,
    url: string,
    opts: { proxies?: boolean; verified?: boolean } = {},
  ): Promise<BrowseSession> {
    const s = new BrowseSession(name);
    const args = ['open', url, '--remote', '-s', name];
    if (opts.proxies) args.push('--proxies'); // residential proxies for bot-protected sites
    if (opts.verified) args.push('--verified'); // advanced stealth (Scale plan)
    const out = await browse(args);
    s.sessionUrl = out?.browserbaseSessionUrl ?? null;
    s.liveViewUrl = out?.browserbaseDebugUrl ?? null;
    s.sessionId = out?.browserbaseSessionId ?? s.sessionUrl?.match(/sessions\/([a-f0-9-]+)/)?.[1] ?? null;
    s.record({ cmd: 'open', arg: url });
    return s;
  }

  /** Navigate the session's tab to a new URL (same isolated session). */
  async navigate(url: string): Promise<void> {
    return this.enqueue(async () => {
      this.record({ cmd: 'open', arg: url });
      await browse(['open', url, '--remote', '-s', this.name]);
    });
  }

  /**
   * Run ANY browse subcommand against this session — the full CLI, exposed as
   * one tool. `-s <session>` is appended automatically (and `--remote` for
   * open). `logAs` is what shows in the audit log / activity feed (token form);
   * the actual `args` are what execute (secrets already resolved by the caller).
   */
  async exec(args: string[], logAs?: string): Promise<any> {
    return this.enqueue(async () => {
      const full = [...args, '-s', this.name];
      if (args[0] === 'open' && !args.includes('--remote')) full.splice(1, 0, '--remote');
      this.record({ cmd: args[0], arg: logAs ?? args.slice(1).join(' ') });
      return browse(full);
    });
  }

  /** Accessibility-tree snapshot with element refs the agent can act on. */
  async snapshot(): Promise<string> {
    return this.enqueue(async () => {
      const r = await browse(['snapshot', '-s', this.name]);
      this.record({ cmd: 'snapshot' });
      return typeof r?.tree === 'string' ? r.tree : JSON.stringify(r);
    });
  }

  /** Fill a non-sensitive value (already a plaintext, non-secret string). */
  async fill(ref: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      this.record({ cmd: 'fill', arg: `${ref}=${value}` });
      await browse(['fill', ref, value, '-s', this.name]);
    });
  }

  /**
   * Fill a field whose value is (or contains) a vault TOKEN. The real secret
   * is resolved right here and handed straight to the CLI — it is never
   * returned, logged, or placed in workflow data. The audit log records only
   * the token.
   */
  async fillSecret(ref: string, tokenValue: string, vault: Vault): Promise<void> {
    return this.enqueue(async () => {
      this.record({ cmd: 'fillSecret', arg: `${ref}=${tokenValue}` });
      const real = vault.resolve(tokenValue);
      await browse(['fill', ref, real, '-s', this.name]);
    });
  }

  async click(ref: string): Promise<void> {
    return this.enqueue(async () => {
      this.record({ cmd: 'click', arg: ref });
      await browse(['click', ref, '-s', this.name]);
    });
  }

  async getText(): Promise<string> {
    return this.enqueue(async () => {
      this.record({ cmd: 'getText' });
      const r = await browse(['get', 'text', 'body', '-s', this.name]);
      return typeof r?.text === 'string' ? r.text : JSON.stringify(r);
    });
  }

  async close(): Promise<void> {
    try {
      await browse(['stop', '-s', this.name]);
    } catch {
      /* best-effort */
    }
  }
}
