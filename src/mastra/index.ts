/**
 * The Mastra instance — this is what `mastra dev` (Studio) loads, and what the
 * runner triggers. Real observability: every workflow + step run is captured as
 * a span, persisted to LibSQL/DuckDB storage, and viewable in Studio's Traces.
 *
 * SensitiveDataFilter is auto-applied to every config; we widen its field list
 * beyond the defaults (which already include `ssn`) to also cover email / phone
 * / name, so the applicant's identity is redacted everywhere before export.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';

// Repo root, resolved the same way from BOTH the source tree (src/mastra/) and
// the `mastra dev` bundle (.mastra/output/) — two levels up either way. This
// anchors the .env AND the storage files, so the CLI runner, the UI server,
// and Studio all read/write the SAME databases (relative paths would silently
// split them by process cwd, and Studio would show zero traces).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load Browserbase creds from .env so ANY process that loads this instance
// (the CLI runner AND `mastra dev` / Studio) can drive the browse CLI.
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {/* optional */}
import {
  Observability,
  MastraStorageExporter,
  TestExporter,
} from '@mastra/observability';
import { relocationConcierge } from '../workflow.js';
import { findApartmentsAgent, applyToApartmentAgent } from './agents.js';
// teaching examples (shown first in the live demo)
import { helloAgent, shoutWorkflow, haikuWorkflow, reviewWorkflow } from './learn.js';

/**
 * In-memory exporter, exported so the CLI runner can read back the EXPORTED
 * (already-redacted) spans and prove redaction inline during the dry-run —
 * the same spans Studio shows visually. Harmless when loaded by `mastra dev`.
 */
export const testExporter = new TestExporter();

// LibSQL (SQLite) for EVERYTHING including observability: unlike DuckDB it
// tolerates multiple processes (CLI runner / UI server writing traces while
// Studio reads them) — essential because the demo runs outside `mastra dev`.
const storage = new LibSQLStore({ id: 'mastra-storage', url: `file:${join(ROOT, 'mastra.db')}` });

const observability = new Observability({
  configs: {
    default: {
      serviceName: 'relocation-concierge',
      exporters: [new MastraStorageExporter(), testExporter],
    },
  },
  // widen the default redaction set (defaults already include `ssn`)
  sensitiveDataFilter: {
    sensitiveFields: [
      'ssn',
      'email',
      'phone',
      'name',
      'applicantname',
      // keep the security-relevant defaults too
      'password',
      'token',
      'secret',
      'apikey',
      'authorization',
      'credential',
    ],
  },
});

export const mastra = new Mastra({
  storage,
  observability,
  workflows: {
    'relocation-concierge': relocationConcierge,
    // teaching examples
    'shout-workflow': shoutWorkflow,
    'haiku-workflow': haikuWorkflow,
    'review-workflow': reviewWorkflow,
  },
  agents: {
    'find-apartments-agent': findApartmentsAgent,
    'apply-to-apartment-agent': applyToApartmentAgent,
    // teaching example
    'hello-agent': helloAgent,
  },
});
