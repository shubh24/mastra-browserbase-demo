/**
 * relocate.ai — demo runner.
 *
 * Kicks off the concierge workflow through the Mastra instance (so it is
 * traced for real), pauses at the human-in-the-loop approval (durable
 * suspend), then reads the EXPORTED (already SensitiveDataFilter-redacted)
 * spans back to prove the persisted trace — the one a support engineer sees
 * in Studio — carries no PII.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { mastra, testExporter } from './mastra/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// load Browserbase / Anthropic creds from local .env
try {
  const env = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {/* optional */}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  orange: (s: string) => `\x1b[38;5;202m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const rule = (t: string) =>
  console.log('\n' + C.orange('━━━ ') + C.bold(t) + C.orange(' ' + '━'.repeat(Math.max(2, 54 - t.length))));

async function main() {
  // Brandon's REAL sensitive data — flows through the durable workflow,
  // never through a model, never into an exported span.
  const secrets = { ssn: '123-45-6789', email: 'brandon.barros@example.com', phone: '+1-415-555-0142' };

  rule('RELOCATE.AI  ·  powered by Browserbase × Mastra');
  console.log(C.dim('  customer: Brandon — moving to San Francisco, wants a 1BR under $3,000'));

  const run = await mastra.getWorkflow('relocation-concierge').createRun();
  let res = await run.start({
    inputData: {
      userId: 'u_8842',
      applicant: {
        name: 'Brandon Barros',
        dob: '4/12/1996',
        currentAddress: '88 King St Apt 4, Seattle, WA 98104',
        ...secrets,
      },
      city: 'sfbay',
      searchPath: 'sfc/apa',
      query: '1 bedroom',
      budgetMax: 4500,
      moveIn: '8/1/2026',
      incomeMonthly: '$11,600',
    },
  });

  // ── human-in-the-loop: the run is durably suspended until approval ──
  if (res.status === 'suspended') {
    const payload: any = (res as any).steps?.['approve-application']?.suspendPayload ?? {};
    rule('APPROVAL REQUIRED  (durable suspend — the run is checkpointed)');
    console.log('  ' + C.cyan(payload.summary ?? 'approve application?'));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(C.bold('\n  approve? [y/N] '))).trim().toLowerCase();
    rl.close();
    res = await run.resume({
      step: (res as any).suspended[0],
      resumeData: { approved: answer === 'y' || answer === 'yes' },
    });
  }

  if (res.status !== 'success') {
    console.error(C.red('\nworkflow did not complete: ' + res.status));
    console.error(JSON.stringify((res as any).error ?? res, null, 2).slice(0, 1200));
    process.exit(1);
  }
  const out = (res as any).result;

  rule('1 · SEARCH  (agent browsing craigslist in the live view)');
  for (const l of out.shortlist ?? []) console.log(C.dim(`    ${l.price.padEnd(8)} ${l.title.slice(0, 70)}`));

  rule('2 · MATCH  (deterministic — partner portal availability)');
  console.log(`  matched: ${C.cyan(out.chosen.title.slice(0, 60))}  ${C.bold(out.chosen.price)}`);
  console.log(C.dim(`  ${out.chosen.reasoning.slice(0, 160)}`));

  rule('3 · APPLY  (agent + browse CLI, same isolated session)');
  console.log(`  submitted: ${out.submitted ? C.green('yes') : C.red('no')}`);
  console.log(C.dim(`  confirmation: ${out.confirmation.slice(0, 160)}`));
  if (out.sessionUrl) console.log(C.dim(`  session replay: ${out.sessionUrl}`));

  rule('4 · AUDIT LOG  (what the browser actually did — tokens only)');
  for (const a of out.browserActions.slice(0, 30)) {
    console.log(C.dim(`    ${a.cmd.padEnd(11)} ${a.arg ?? ''}`.slice(0, 110)));
  }
  if (out.browserActions.length > 30) console.log(C.dim(`    … ${out.browserActions.length - 30} more`));

  // let the exporter pipeline settle
  await new Promise((r) => setTimeout(r, 400));

  rule('5 · OBSERVABILITY  (real, redacted spans → Mastra Studio)');
  const spans = testExporter.getCompletedSpans();
  console.log(C.dim(`  ${spans.length} spans exported — what Studio shows a support engineer`));

  rule('LEAK CHECK  (across ALL exported spans)');
  const blob = JSON.stringify(spans);
  const leaked = Object.entries(secrets).filter(([, v]) => blob.includes(v));
  if (leaked.length === 0) console.log(C.green('  ✓ zero real secrets present in the exported trace'));
  else console.log(C.red(`  ✗ LEAK: ${leaked.map(([k]) => k).join(', ')}`));
  console.log(`  redaction marker present: ${blob.includes('[REDACTED]') ? C.green('✓ [REDACTED] found') : C.dim('— none')}`);
  console.log(`  vault tokens visible instead: ${blob.includes('{{vault.ssn}}') ? C.green('✓ {{vault.ssn}}') : C.dim('— none')}`);

  await testExporter.writeToFile(join(__dirname, '..', 'trace.redacted.json')).catch(() => {});
  rule('VIEW IN MASTRA STUDIO');
  console.log('  ' + C.cyan('npm run dev') + C.dim('  → Agents: the two relocate.ai agents · Traces: this run, PII-redacted'));

  await mastra.shutdown?.().catch?.(() => {});
  process.exit(0);
}

main().catch((e) => { console.error(C.red('FATAL'), e); process.exit(1); });
