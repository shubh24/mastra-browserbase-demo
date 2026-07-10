/**
 * The two safety primitives the Mastra demo showcases.
 *
 *  1. Vault  — secret/variable substitution (Stagehand-style). The agent, the
 *     workflow data, and any LLM context only ever see opaque tokens like
 *     `{{vault.ssn}}`. The real value is resolved to plaintext ONLY at the
 *     browser-fill boundary, inside browse-cli. Secrets never enter the model.
 *
 *  2. redact() — a trace processor. Anything written to the observability /
 *     replay store passes through this first, so a support engineer can replay
 *     a run without ever seeing the user's identity.
 */

export type Secrets = Record<string, string>;

/** Holds real secrets out-of-band and hands out tokens for them. */
export class Vault {
  private store = new Map<string, string>();

  constructor(secrets: Secrets) {
    for (const [k, v] of Object.entries(secrets)) this.store.set(k, v);
  }

  /** The token an agent/workflow passes around instead of the real value. */
  token(key: string): string {
    if (!this.store.has(key)) throw new Error(`vault: no secret named "${key}"`);
    return `{{vault.${key}}}`;
  }

  /** Resolve every {{vault.x}} token to its real value. Call this ONLY at the
   *  last possible moment — i.e. inside the browse-cli fill, never before. */
  resolve(input: string): string {
    return input.replace(/\{\{vault\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
      const v = this.store.get(key);
      if (v === undefined) throw new Error(`vault: unresolved token "${key}"`);
      return v;
    });
  }

  /** Does this string still carry an unresolved token? (used for assertions) */
  static hasToken(s: string): boolean {
    return /\{\{vault\.[a-zA-Z0-9_]+\}\}/.test(s);
  }

  /**
   * The inverse of resolve(): replace any REAL secret value found in text with
   * its token. Applied to everything the browser reports back (snapshots,
   * page text) so a secret that was typed into the page can never re-enter
   * the model context or the trace. The boundary is bidirectional.
   */
  mask(text: string): string {
    let out = text;
    for (const [key, value] of this.store.entries()) {
      if (!value) continue;
      out = out.split(value).join(`{{vault.${key}}}`);
    }
    return out;
  }
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED:SSN]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:EMAIL]'],
  [/(\+?\d[\d\s().-]{7,}\d)/g, '[REDACTED:PHONE]'],
];

/** Mask PII anywhere in an arbitrary JSON-able value (deep). */
export function redact<T>(value: T, extraNames: string[] = []): T {
  const nameRes = extraNames
    .filter(Boolean)
    .map(n => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));

  const scrub = (s: string): string => {
    let out = s;
    for (const [re, tag] of PATTERNS) out = out.replace(re, tag);
    for (const re of nameRes) out = out.replace(re, '[REDACTED:NAME]');
    return out;
  };

  const walk = (v: any): any => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(value);
}
