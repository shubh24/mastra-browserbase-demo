/**
 * relocate.ai — thin demo UI server (no framework, no build step).
 *
 *   GET  /            the one-page relocate.ai app
 *   POST /api/start   kick off the concierge workflow for Jane
 *   GET  /api/state   poll workflow progress (display-safe facts only)
 *   POST /api/approve resume the durably-suspended run { approved: boolean }
 *
 * The workflow itself is the exact same Mastra workflow the CLI runner uses —
 * this server is just a product-shaped skin over start/suspend/resume.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mastra } from './mastra/index.js';
import { demoState, resetDemoState } from './demo-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// load creds from .env for any process that starts the server directly
try {
  for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {/* optional */}

const PORT = Number(process.env.PORT || 4747);

// one demo run at a time — deliberately simple
let activeRun: any = null;

async function startWorkflow(input: { budgetMax: number; query: string }) {
  resetDemoState();
  demoState.phase = 'finding';

  const run = await mastra.getWorkflow('relocation-concierge').createRun();
  activeRun = run;

  const res = await run.start({
    inputData: {
      userId: 'u_8842',
      applicant: {
        name: 'Jane Q. Applicant',
        dob: '4/12/1996',
        currentAddress: '88 King St Apt 4, Seattle, WA 98104',
        ssn: '123-45-6789',
        email: 'jane.applicant@example.com',
        phone: '+1-415-555-0142',
      },
      city: 'sfbay',
      searchPath: 'sfc/apa',
      query: input.query,
      budgetMax: input.budgetMax,
      moveIn: '8/1/2026',
      incomeMonthly: '$11,600',
    },
  });

  if (res.status === 'failed') {
    demoState.phase = 'error';
    demoState.error = String((res as any).error?.message ?? 'workflow failed');
  }
  // on 'suspended' the approve step has already set phase = awaiting-approval
}

async function resumeWorkflow(approved: boolean) {
  if (!activeRun) throw new Error('no active run');
  if (!approved) {
    demoState.phase = 'declined';
    return;
  }
  const res = await activeRun.resume({
    step: 'approve-application',
    resumeData: { approved: true },
  });
  if (res.status === 'failed') {
    demoState.phase = 'error';
    demoState.error = String((res as any).error?.message ?? 'workflow failed');
  }
}

function json(res: any, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(__dirname, '..', 'public', 'index.html')));
    return;
  }

  // static assets (logos, images) under public/assets — path-traversal guarded
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const root = join(__dirname, '..', 'public');
    const file = join(root, url.pathname.replace(/^\/+/, ''));
    if (!file.startsWith(root)) return json(res, 403, { error: 'forbidden' });
    const types: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp',
    };
    try {
      const buf = readFileSync(file);
      const ext = file.split('.').pop() ?? '';
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
      res.end(buf);
    } catch {
      json(res, 404, { error: 'not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, demoState);
  }

  // Session-replay proxy: fetches the HLS manifest server-side so the
  // Browserbase API key never reaches the page. The manifest's segment URLs
  // are signed CDN links the player can fetch directly.
  if (req.method === 'GET' && url.pathname.startsWith('/api/replay/')) {
    const sessionId = url.pathname.split('/')[3];
    const key = process.env.BROWSERBASE_API_KEY ?? '';
    try {
      const metaRes = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/replays`, {
        headers: { 'x-bb-api-key': key },
      });
      if (!metaRes.ok) return json(res, 425, { retry: true, status: metaRes.status });
      const meta: any = await metaRes.json();
      const pages: any[] = meta?.pages ?? (Array.isArray(meta) ? meta : []);
      if (!pages.length) return json(res, 425, { retry: true, reason: 'no pages yet' });
      // longest page = the main story of the session
      const page = [...pages].sort(
        (a, b) => (b.duration ?? b.durationMs ?? 0) - (a.duration ?? a.durationMs ?? 0),
      )[0];
      const pageId = page.pageId ?? page.id;
      const plRes = await fetch(
        `https://api.browserbase.com/v1/sessions/${sessionId}/replays/${pageId}`,
        { headers: { 'x-bb-api-key': key } },
      );
      if (!plRes.ok) return json(res, 425, { retry: true, status: plRes.status });
      const manifest = await plRes.text();
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(manifest);
    } catch (e: any) {
      json(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const budgetMax = Number(parsed.budgetMax) || 4500;
      const query = String(parsed.query || '1 bedroom');
      // fire and forget — the UI polls /api/state
      startWorkflow({ budgetMax, query }).catch((e) => {
        demoState.phase = 'error';
        demoState.error = String(e?.message ?? e);
      });
      json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/approve') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      resumeWorkflow(Boolean(parsed.approved)).catch((e) => {
        demoState.phase = 'error';
        demoState.error = String(e?.message ?? e);
      });
      json(res, 200, { ok: true });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  relocate.ai demo → http://localhost:${PORT}\n`);
});
