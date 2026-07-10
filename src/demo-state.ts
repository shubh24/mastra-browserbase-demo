/**
 * Tiny in-process bridge between the workflow steps and the demo UI server.
 * Steps push display-safe facts here (never secrets); the UI polls them.
 */

export interface DemoSession {
  /** which agent/site this browser belongs to: 'craigslist' | 'zillow' | 'apply' */
  label: string;
  title: string;
  sessionId: string | null;
  liveViewUrl: string | null;
  sessionUrl: string | null;
  /** 'live' → iframe the live view; 'done' → swap to the session replay player */
  status: 'live' | 'done';
}

export interface DemoEvent {
  t: number;
  /** feed lane: 'craigslist' | 'zillow' | 'apply' | 'workflow' */
  agent: string;
  text: string;
}

export interface DemoState {
  phase:
    | 'idle'
    | 'finding'
    | 'awaiting-approval'
    | 'applying'
    | 'done'
    | 'declined'
    | 'error';
  attempt: number;
  shortlist: Array<{ title: string; price: string; url: string; source: string }>;
  chosen: { title: string; price: string; reasoning: string } | null;
  approvalSummary: string | null;
  sessions: DemoSession[];
  events: DemoEvent[];
  submitted: boolean;
  confirmation: string | null;
  error: string | null;
}

export const demoState: DemoState = {
  phase: 'idle',
  attempt: 0,
  shortlist: [],
  chosen: null,
  approvalSummary: null,
  sessions: [],
  events: [],
  submitted: false,
  confirmation: null,
  error: null,
};

export function resetDemoState(): void {
  Object.assign(demoState, {
    phase: 'idle',
    attempt: 0,
    shortlist: [],
    chosen: null,
    approvalSummary: null,
    sessions: [],
    events: [],
    submitted: false,
    confirmation: null,
    error: null,
  } satisfies DemoState);
}

/** Append a line to the activity feed (bounded so the state stays small). */
export function pushEvent(agent: string, text: string): void {
  demoState.events.push({ t: Date.now(), agent, text: text.slice(0, 300) });
  if (demoState.events.length > 400) demoState.events.splice(0, demoState.events.length - 400);
}

/** Create or update a session card in the UI. */
export function upsertSession(s: DemoSession): void {
  const existing = demoState.sessions.find((x) => x.label === s.label);
  if (existing) Object.assign(existing, s);
  else demoState.sessions.push(s);
}

export function markSessionDone(label: string): void {
  const s = demoState.sessions.find((x) => x.label === label);
  if (s) s.status = 'done';
}
