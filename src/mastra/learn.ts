/**
 * ────────────────────────────────────────────────────────────────────────────
 *  MASTRA IN FOUR STEPS  ·  a teaching file for the live demo
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  Show this file top-to-bottom, then flip to Mastra Studio and run each one.
 *  Each section adds ONE new idea:
 *
 *    1. Agent      — a model + a job + tools
 *    2. Workflow   — typed steps wired together, run durably by Mastra
 *    3. Agent-in-a-workflow — mix deterministic code with a non-deterministic agent
 *    4. Human-in-the-loop   — a workflow that pauses for approval, then resumes
 *
 *  All four are registered on the Mastra instance, so they appear in Studio
 *  under Agents / Workflows and can be run from the playground.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

const MODEL = process.env.CONCIERGE_MODEL || 'anthropic/claude-opus-4-8';

// ════════════════════════════════════════════════════════════════════════════
// 1 · AN AGENT  =  model + instructions + tools
// ════════════════════════════════════════════════════════════════════════════
// A tool is a plain typed function the agent can call. Zod schemas describe the
// input/output, so the model knows how to call it and Mastra validates the args.
const wordCountTool = createTool({
  id: 'word-count',
  description: 'Count how many words are in a piece of text.',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ count: z.number() }),
  execute: async ({ text }) => ({
    count: text.trim().split(/\s+/).filter(Boolean).length,
  }),
});

// An agent bundles a model, a system prompt (its job + rules), and its tools.
// That's it — this is a fully working agent you can chat with in Studio.
export const helloAgent = new Agent({
  id: 'hello-agent',
  name: 'Hello Agent',
  description: 'Teaching example 1: the simplest agent — a model, a one-sentence job, and one tool (word-count).',
  model: MODEL,
  instructions: `You are a concise, friendly assistant. Answer in one sentence.
When the user asks how long a piece of text is, call the word-count tool.`,
  tools: { wordCountTool },
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · A WORKFLOW  =  typed steps, wired together
// ════════════════════════════════════════════════════════════════════════════
// A step is a function with typed input/output. Mastra runs the steps in order,
// validates the data handed between them, and checkpoints state after each one.
// No model here yet — a workflow is just as useful for deterministic pipelines.
const toUpper = createStep({
  id: 'to-upper',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData }) => ({ text: inputData.text.toUpperCase() }),
});

const addExcitement = createStep({
  id: 'add-excitement',
  inputSchema: z.object({ text: z.string() }),   // matches toUpper's output
  outputSchema: z.object({ text: z.string() }),
  execute: async ({ inputData }) => ({ text: `${inputData.text}!!!` }),
});

// .then() wires steps into a graph. .commit() finalizes it. This is what Studio
// draws as a two-node flow.
export const shoutWorkflow = createWorkflow({
  id: 'shout-workflow',
  description: 'Teaching example 2: a deterministic workflow. Two typed steps wired with .then() (uppercase, then add "!!!"). No model — shows how Mastra runs, validates, and checkpoints steps.',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
})
  .then(toUpper)
  .then(addExcitement)
  .commit();

// ════════════════════════════════════════════════════════════════════════════
// 3 · AGENT INSIDE A WORKFLOW  =  deterministic + non-deterministic together
// ════════════════════════════════════════════════════════════════════════════
// The whole point of Mastra: a workflow gives you a reliable skeleton, and any
// step can call an agent for the fuzzy, model-driven part.
const writeHaiku = createStep({
  id: 'write-haiku',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ haiku: z.string() }),
  execute: async ({ inputData }) => {
    // the non-deterministic bit: hand the job to an agent
    const res = await helloAgent.generate(
      `Write a haiku about "${inputData.topic}". Output only the haiku, three lines.`,
    );
    return { haiku: res.text };
  },
});

const countLines = createStep({
  id: 'count-lines',
  inputSchema: z.object({ haiku: z.string() }),
  outputSchema: z.object({ haiku: z.string(), lines: z.number() }),
  // the deterministic bit: plain code, no model
  execute: async ({ inputData }) => ({
    haiku: inputData.haiku,
    lines: inputData.haiku.split('\n').filter((l) => l.trim()).length,
  }),
});

export const haikuWorkflow = createWorkflow({
  id: 'haiku-workflow',
  description: 'Teaching example 3: an agent inside a workflow. An agent step writes a haiku, then a deterministic step counts the lines — deterministic and non-deterministic together.',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ haiku: z.string(), lines: z.number() }),
})
  .then(writeHaiku)   // agent step
  .then(countLines)   // deterministic step
  .commit();

// ════════════════════════════════════════════════════════════════════════════
// 4 · HUMAN-IN-THE-LOOP  =  durable suspend / resume
// ════════════════════════════════════════════════════════════════════════════
// A step can pause the whole workflow with suspend(). Mastra checkpoints the run
// to storage — the process can restart, hours can pass — and run.resume() picks
// up exactly here. This is how the relocation demo waits for Brandon's approval.
const draftPost = createStep({
  id: 'draft-post',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ draft: z.string() }),
  execute: async ({ inputData }) => {
    const res = await helloAgent.generate(
      `Write a single-sentence social post about "${inputData.topic}".`,
    );
    return { draft: res.text };
  },
});

const reviewAndPublish = createStep({
  id: 'review-and-publish',
  inputSchema: z.object({ draft: z.string() }),
  outputSchema: z.object({ status: z.string() }),
  // suspendSchema: what the paused run hands back to the caller/UI
  suspendSchema: z.object({ draft: z.string() }),
  // resumeSchema: what the caller sends in to continue
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData?.approved) {
      // pause here until someone resumes with { approved: true }
      return await suspend({ draft: inputData.draft });
    }
    return { status: `published: ${inputData.draft}` };
  },
});

export const reviewWorkflow = createWorkflow({
  id: 'review-workflow',
  description: 'Teaching example 4: human-in-the-loop. Drafts a post, then suspends for approval and resumes on run.resume() — the durable suspend/resume the relocation demo uses.',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ status: z.string() }),
})
  .then(draftPost)
  .then(reviewAndPublish)   // suspends for approval
  .commit();
