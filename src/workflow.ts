/**
 * relocate.ai concierge workflow — deterministic and agentic steps together.
 *
 *   1. search (dountil loop over a nested workflow)
 *        ├─ search-craigslist    (agent, own browser session)   ← runs in
 *        ├─ search-apartments-com (agent, own browser session)  ← PARALLEL
 *        └─ merge-shortlists     (deterministic validation)
 *   2. approve-application    (durable suspend)  human confirms THE apartment
 *   3. apply-to-apartment     (agent, fresh browser session) fills the portal
 *
 * Each browser is an isolated Browserbase session with its own live view —
 * the UI shows them side by side, then swaps each for its session replay.
 *
 * Two safety pillars, both visible in the REAL Mastra trace (Studio):
 *   - Pillar 1  SensitiveDataFilter: PII is redacted from every span at export.
 *   - Pillar 2  Vault / token substitution, BIDIRECTIONAL: the model only ever
 *     sees {{vault.*}} tokens; plaintext exists at the browser wire only, and
 *     anything the page echoes back is re-masked before reaching the model.
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { Vault } from './pii.js';
import { BrowseSession } from './browse-cli.js';
import { registerRun, releaseRun, getRunResources } from './tools.js';
import { findApartmentsAgent, applyToApartmentAgent } from './mastra/agents.js';
import { demoState, pushEvent, upsertSession, markSessionDone } from './demo-state.js';

export const APPLICATION_URL =
  process.env.APPLY_URL ||
  'https://fellstreetpropertymanagement.managebuilding.com/Resident/rental-application/new';

/** The property the concierge matches on the partner portal (our Buildium listing). */
export const TARGET_PROPERTY = process.env.APPLY_PROPERTY || '424242 Fell St - 42';
export const TARGET_PRICE = process.env.APPLY_PRICE || '$2,850';

const shortlistItemSchema = z.object({
  title: z.string(),
  price: z.string(),
  url: z.string(),
  source: z.string(),
});

const chosenListingSchema = z.object({
  title: z.string(),
  price: z.string(),
  beds: z.number().nullable(),
  reasoning: z.string().describe('why this listing beat the others'),
  consideredCount: z.number().describe('how many listings were evaluated'),
});

// real PII — deliberately in named fields so SensitiveDataFilter redacts them.
const applicantSchema = z.object({
  name: z.string(),
  dob: z.string(),
  ssn: z.string(),
  email: z.string(),
  phone: z.string(),
  currentAddress: z.string(),
});

const conciergeInput = z.object({
  userId: z.string(),
  applicant: applicantSchema,
  city: z.string(),
  searchPath: z.string(),
  query: z.string(),
  budgetMax: z.number(),
  moveIn: z.string(),
  incomeMonthly: z.string(),
});

/**
 * Search loop state. runKey points at the run's live sessions/vault in the
 * in-process registry — only this opaque string travels through workflow data.
 */
const searchLoopState = conciergeInput.extend({
  runKey: z.string(),
  attempt: z.number(),
  rejectionReason: z.string().nullable(),
  shortlist: z.array(shortlistItemSchema),
  ok: z.boolean(),
});

const matchedState = searchLoopState.extend({ chosen: chosenListingSchema });

const conciergeOutput = z.object({
  shortlist: z.array(shortlistItemSchema),
  chosen: chosenListingSchema,
  submitted: z.boolean(),
  confirmation: z.string(),
  browserActions: z.array(z.object({ cmd: z.string(), arg: z.string().optional() })),
  liveViewUrl: z.string().nullable(),
  sessionUrl: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// search branches — one agent per site, each in its own browser session,
// running in PARALLEL. Isolated Browserbase sessions make the fan-out trivial.
// ---------------------------------------------------------------------------

interface SiteConfig {
  label: string;
  title: string;
  skillName: string;   // browse.sh catalog slug (for the activity feed)
  skillLoad: string;   // native Mastra skill name the agent loads
  proxies: boolean;
  verified: boolean;
  url: (input: z.infer<typeof searchLoopState>) => string;
}

const SITES: Record<string, SiteConfig> = {
  craigslist: {
    label: 'craigslist',
    title: 'Craigslist',
    skillName: 'craigslist.org/search-listings',
    skillLoad: 'craigslist',
    proxies: false,
    verified: false,
    url: (i) =>
      `https://${i.city}.craigslist.org/search/${i.searchPath}` +
      `?query=${encodeURIComponent(i.query)}&max_price=${i.budgetMax}`,
  },
  apartments: {
    label: 'apartments',
    title: 'Apartments.com',
    skillName: 'apartments.com/search-rentals',
    skillLoad: 'apartments',
    // Apartments.com is behind Akamai Bot Manager — the skill mandates
    // stealth + residential proxies, exactly the Browserbase capability we show
    proxies: true,
    verified: true,
    url: (i) => `https://www.apartments.com/san-francisco-ca/1-bedrooms-under-${i.budgetMax}/`,
  },
};

function makeSearchStep<Id extends string>(id: Id, site: SiteConfig) {
  return createStep({
    id,
    inputSchema: searchLoopState,
    outputSchema: searchLoopState,
    execute: async ({ inputData }) => {
      demoState.phase = 'finding';
      demoState.attempt = inputData.attempt + 1;

      const run = getRunResources(inputData.runKey);
      if (!run) throw new Error('run resources missing');

      // open this site's own isolated session on the first loop iteration
      let session = run.sessions.get(site.label);
      if (!session) {
        pushEvent(site.label, `▶ importing skill: ${site.skillName}`);
        const url = site.url(inputData);
        pushEvent(site.label, `navigating to ${url}`);
        try {
          session = await BrowseSession.openIsolated(
            `reloc-${inputData.userId}-${site.label}`,
            url,
            { proxies: site.proxies, verified: site.verified },
          );
        } catch {
          // verified/advanced-stealth may be plan-gated — fall back gracefully
          pushEvent(site.label, 'advanced stealth unavailable, retrying with proxies only');
          session = await BrowseSession.openIsolated(
            `reloc-${inputData.userId}-${site.label}`,
            url,
            { proxies: site.proxies },
          );
        }
        run.sessions.set(site.label, session);
        session.onAction = (a) => pushEvent(site.label, `${a.cmd} ${a.arg ?? ''}`.trim());
        upsertSession({
          label: site.label,
          title: `${site.title} — search`,
          sessionId: session.sessionId,
          liveViewUrl: session.liveViewUrl,
          sessionUrl: session.sessionUrl,
          status: 'live',
        });
        if (session.liveViewUrl) console.log(`  🔴 ${site.title} live view: ${session.liveViewUrl}`);
      }

      const requestContext = new RequestContext<{ runKey: string; sessionLabel: string }>();
      requestContext.set('runKey', inputData.runKey);
      requestContext.set('sessionLabel', site.label);

      const feedback = inputData.rejectionReason
        ? `\n\nYour previous shortlist was REJECTED: ${inputData.rejectionReason}
           Snapshot again (scroll / read more of the page) and extract a better shortlist.`
        : '';

      const result = await findApartmentsAgent.generate(
        `The browser is already open on ${site.title}, on the search results page for the customer:
         looking for "${inputData.query}" in San Francisco, HARD budget $${inputData.budgetMax}/month.

         First, load the imported "${site.skillLoad}" skill with the skill tool and follow its
         browser workflow, selectors, and site-specific gotchas.

         Then extract a shortlist of up to 6 real listings, all at or under budget, using the
         browser (snapshot / eval / get html) so the work is visible. For EACH listing capture
         the title, the monthly price, AND the listing's canonical URL (the skill documents how
         to build/read it).${feedback}`,
        {
          requestContext,
          maxSteps: 25,
          // per-run, per-site memory thread (persisted; visible in Studio)
          memory: { thread: `${inputData.runKey}:${site.label}`, resource: inputData.userId },
          onStepFinish: (step: any) => {
            const text = String(step?.text ?? '').trim();
            if (text) pushEvent(site.label, `💭 ${text}`);
          },
          structuredOutput: {
            schema: z.object({
              listings: z.array(z.object({
                title: z.string(),
                price: z.string(),
                url: z.string().describe('canonical listing URL'),
              })),
            }),
            model: 'anthropic/claude-haiku-4-5',
          },
        } as any,
      );

      const found = (result.object?.listings ?? []).map(
        (l: { title: string; price: string; url?: string }) => ({
          title: l.title, price: l.price, url: l.url ?? '', source: site.title,
        }),
      );

      // deterministic guardrail — plain code, not a model
      const valid = found.filter((l: { title: string; price: string; source: string }) => {
        const price = Number(l.price.replace(/[^0-9.]/g, ''));
        return Number.isFinite(price) && price > 0 && price <= inputData.budgetMax;
      });

      pushEvent(site.label, `✅ extracted ${valid.length} within-budget listings`);

      return { ...inputData, shortlist: valid };
    },
  });
}

const searchCraigslist = makeSearchStep('search-craigslist', SITES.craigslist);
const searchApartments = makeSearchStep('search-apartments-com', SITES.apartments);

// ---------------------------------------------------------------------------
// merge — deterministic: combine both branches, validate, close search browsers
// ---------------------------------------------------------------------------

const MAX_SEARCH_ATTEMPTS = 3;
const MIN_SHORTLIST = 3;

const mergeShortlists = createStep({
  id: 'merge-shortlists',
  inputSchema: z.object({
    'search-craigslist': searchLoopState,
    'search-apartments-com': searchLoopState,
  }),
  outputSchema: searchLoopState,
  execute: async ({ inputData }) => {
    const a = inputData['search-craigslist'];
    const b = inputData['search-apartments-com'];
    const combined = [...a.shortlist, ...b.shortlist];
    const attempt = a.attempt + 1;
    const ok = combined.length >= MIN_SHORTLIST;

    if (!ok && attempt >= MAX_SEARCH_ATTEMPTS) {
      throw new Error(`only ${combined.length} valid listings after ${attempt} attempts`);
    }

    demoState.shortlist = combined;
    pushEvent('workflow', `merged shortlists: ${a.shortlist.length} craigslist + ${b.shortlist.length} apartments.com`);

    if (ok) {
      // search is done — end both browsers so their session replays are ready
      const run = getRunResources(a.runKey);
      for (const label of ['craigslist', 'apartments']) {
        const s = run?.sessions.get(label);
        if (s) {
          await s.close();
          markSessionDone(label);
        }
      }
    }

    return {
      ...a,
      attempt,
      shortlist: combined,
      ok,
      rejectionReason: ok
        ? null
        : `only ${combined.length} within-budget listings across both sites (need ${MIN_SHORTLIST}+)`,
    };
  },
});

/** Nested workflow: both site searches in parallel, then merge + validate. */
const searchAllSites = createWorkflow({
  id: 'search-all-sites',
  inputSchema: searchLoopState,
  outputSchema: searchLoopState,
})
  .parallel([searchCraigslist, searchApartments])
  .then(mergeShortlists)
  .commit();

// ---------------------------------------------------------------------------
// match — deterministic: shortlist → partner portal availability
// ---------------------------------------------------------------------------
// The concierge applies where it has an application channel: properties listed
// on partner property-management portals. For the demo the match is our own
// portal's listing (a real Buildium applicant center we control).

const matchProperty = createStep({
  id: 'match-property',
  inputSchema: searchLoopState,
  outputSchema: matchedState,
  execute: async ({ inputData }) => {
    const chosen = {
      title: TARGET_PROPERTY,
      price: TARGET_PRICE,
      beds: 1,
      reasoning:
        `Matched from ${inputData.shortlist.length} shortlisted listings across Craigslist and Apartments.com: ` +
        `1BR at ${TARGET_PRICE} (under the $${inputData.budgetMax} budget), available ${inputData.moveIn}, ` +
        `and applications are accepted online via the Fell Street Property Management partner portal.`,
      consideredCount: inputData.shortlist.length,
    };
    demoState.chosen = { title: chosen.title, price: chosen.price, reasoning: chosen.reasoning };
    pushEvent('workflow', `matched: ${chosen.title} at ${chosen.price} via partner portal`);
    return { ...inputData, chosen };
  },
});

// ---------------------------------------------------------------------------
// approve — durable suspend before the SSN is submitted anywhere
// ---------------------------------------------------------------------------

const approveApplication = createStep({
  id: 'approve-application',
  inputSchema: matchedState,
  outputSchema: matchedState,
  suspendSchema: z.object({
    summary: z.string(),
  }),
  resumeSchema: z.object({
    approved: z.boolean(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData?.approved) {
      demoState.phase = 'awaiting-approval';
      demoState.approvalSummary =
        `Apply to "${inputData.chosen.title}" at ${inputData.chosen.price}/month?`;
      pushEvent('workflow', '⏸ durable suspend — waiting for customer approval');
      // durable pause: the run checkpoints here — hours or days can pass, the
      // process can restart, and resume picks up exactly where we left off.
      return await suspend({
        summary:
          `Apply to "${inputData.chosen.title}" at ${inputData.chosen.price}? ` +
          `This will submit the customer's rental application (including SSN) to the landlord portal.`,
      });
    }
    pushEvent('workflow', '▶ approved — resuming the checkpointed run');
    return inputData;
  },
});

// ---------------------------------------------------------------------------
// apply — agent in a FRESH isolated session on the landlord portal
// ---------------------------------------------------------------------------

const applyToApartment = createStep({
  id: 'apply-to-apartment',
  inputSchema: matchedState,
  outputSchema: conciergeOutput,
  execute: async ({ inputData }) => {
    const chosen = inputData.chosen;
    const run = getRunResources(inputData.runKey);
    if (!run) throw new Error('browser sessions for this run are gone (process restarted?)');
    const { vault } = run;

    demoState.phase = 'applying';

    pushEvent('apply', '▶ opening the landlord portal (Fell Street Property Management)');
    const session = await BrowseSession.openIsolated(
      `reloc-${inputData.userId}-apply`,
      APPLICATION_URL,
    );
    run.sessions.set('apply', session);
    session.onAction = (a) => pushEvent('apply', vault.mask(`${a.cmd} ${a.arg ?? ''}`.trim()));
    upsertSession({
      label: 'apply',
      title: 'Landlord portal — application',
      sessionId: session.sessionId,
      liveViewUrl: session.liveViewUrl,
      sessionUrl: session.sessionUrl,
      status: 'live',
    });
    if (session.liveViewUrl) console.log(`\n  🔴 apply live view: ${session.liveViewUrl}\n`);

    const requestContext = new RequestContext<{ runKey: string; sessionLabel: string }>();
    requestContext.set('runKey', inputData.runKey);
    requestContext.set('sessionLabel', 'apply');

    try {
      const result = await applyToApartmentAgent.generate(
        `Complete the rental application on the landlord portal (already open in the browser).

         Apply for the property: "${TARGET_PROPERTY}"

         Customer data for the form:
         - Full name / signature: ${inputData.applicant.name}
         - Birth date: ${inputData.applicant.dob}
         - Current address: ${inputData.applicant.currentAddress}
         - Desired move-in: ${inputData.moveIn}
         - Monthly gross income: ${inputData.incomeMonthly}
         - Social security number: ${vault.token('ssn')}
         - Email: ${vault.token('email')}
         - Cell phone: ${vault.token('phone')}
         - Emergency contact: Maya Chen (sister), maya.chen@example.com, 555-201-7788
         - Rental history: 88 King St Apt 4, Seattle, WA 98104 — Jan 2023 to present,
           $2,100/month, reason for leaving: relocating for work,
           landlord: Northgate Property LLC, 555-303-9911
         - Employment: Product Designer at Meridian Labs, Mar 2022 to present,
           supervisor: Dana Ortiz (Design Director), employer phone: 555-402-8800,
           employer address: 1200 Westlake Ave N Suite 500, Seattle, WA 98109

         Fill required fields, accept the terms, sign, submit, and confirm the outcome.`,
        {
          requestContext,
          maxSteps: 120,
          memory: { thread: `${inputData.runKey}:apply`, resource: inputData.userId },
          onStepFinish: (step: any) => {
            const text = String(step?.text ?? '').trim();
            if (text) pushEvent('apply', vault.mask(`💭 ${text}`));
          },
          structuredOutput: {
            schema: z.object({
              submitted: z.boolean(),
              confirmation: z.string().describe('what the confirmation page said'),
            }),
            model: 'anthropic/claude-haiku-4-5',
          },
        } as any,
      );

      const outcome = result.object ?? { submitted: false, confirmation: 'no structured result' };

      // trust but verify: read the final page state deterministically instead of
      // relying only on the agent's self-report
      const finalPage = vault.mask(await session.getText().catch(() => ''));
      const pageConfirms = /thank you|received|submitted|confirmation|application id/i.test(finalPage);
      const submitted = outcome.submitted || pageConfirms;

      pushEvent('apply', submitted ? '✅ application submitted' : '⚠️ submission not confirmed');

      demoState.phase = 'done';
      demoState.submitted = submitted;
      demoState.confirmation = outcome.confirmation;

      return {
        shortlist: inputData.shortlist,
        chosen,
        submitted,
        confirmation: outcome.confirmation,
        // token-safe audit log — this is what support replays in Studio
        browserActions: session.actions,
        liveViewUrl: session.liveViewUrl,
        sessionUrl: session.sessionUrl,
      };
    } finally {
      await session.close();
      markSessionDone('apply');
      releaseRun(inputData.runKey);
    }
  },
});

export const relocationConcierge = createWorkflow({
  id: 'relocation-concierge',
  description:
    'The relocate.ai concierge. Browses Craigslist + Apartments.com in parallel (imported browse.sh skills), ' +
    'matches a listing to the partner portal, pauses for the customer to approve, then fills and submits the ' +
    'rental application. Redacts PII from every trace and keeps secrets out of the model via vault tokens.',
  inputSchema: conciergeInput,
  outputSchema: conciergeOutput,
})
  // initialize loop state + the run's vault/session registry
  .map(async ({ inputData }) => {
    const runKey = `run-${inputData.userId}-${Date.now()}`;
    registerRun(runKey, new Vault({
      ssn: inputData.applicant.ssn,
      email: inputData.applicant.email,
      phone: inputData.applicant.phone,
    }));
    return {
      ...inputData,
      runKey,
      attempt: 0,
      rejectionReason: null,
      shortlist: [],
      ok: false,
    };
  })
  // both sites in parallel → merge → loop until the shortlist passes validation
  .dountil(searchAllSites, async ({ inputData }) => inputData.ok)
  .then(matchProperty)
  .then(approveApplication)
  .then(applyToApartment)
  .commit();
