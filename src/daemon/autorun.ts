import type { CollabDoc, CollabTask } from '../collab/doc.js';

/**
 * Self-driving collaboration loop — pure decision core (ADR-020).
 *
 * The daemon is the clock; this module is the judgement it applies each tick.
 * It is deliberately pure (no I/O): given a task + the current "product"
 * fingerprint + the clock, it returns WHAT to do. The daemon wiring
 * (`startAutoRun`, added separately) resolves owners, gates on monitor/device,
 * sends the nudges, and persists the bookkeeping.
 *
 * The signal is "product, not time" (ADR-017): a worker can only append to its
 * OWN progress section, so a new progress entry is the most reliable evidence it
 * actually did something. No new entry across `maxRetries` ticks ⇒ the lead is
 * asked to judge (redirect the worker, or summarise for the operator). A dumb
 * wall-clock ceiling is the failsafe so a mis-judgement can't run forever.
 */

export interface AutoRunConfig {
  /** Consecutive no-product ticks to self-retry before asking the lead. */
  maxRetries: number;
  /** Hard wall-clock ceiling per task (seconds) — failsafe escalate. */
  maxWallClockSec: number;
}

export const DEFAULT_AUTORUN_CONFIG: AutoRunConfig = {
  maxRetries: 2,
  maxWallClockSec: 3600,
};

export type AutoRunAction =
  /** Not eligible this tick (not auto-run, terminal/paused state, …). */
  | { kind: 'skip'; reason: string }
  /** Product moved forward → nudge the worker to do the next chunk; reset stall. */
  | { kind: 'advance'; fingerprint: string }
  /** No product yet, still within the self-retry budget → nudge the worker again. */
  | { kind: 'retry'; attempt: number }
  /** Stalled past the budget → ask the LEAD to judge (redirect or escalate). */
  | { kind: 'judge'; stalls: number }
  /** Wall-clock ceiling hit → daemon failsafe escalate to the operator. */
  | { kind: 'backstop'; ranForMs: number };

/**
 * The worker's product signal for a task: the size + tail of the OWNER's
 * append-only progress section. A change (new entry, or a changed last entry)
 * means real forward motion. `'none'` when the owner has logged nothing yet.
 *
 * v1 limitation: progress sections are per-agent, not per-task, so if one worker
 * owns several concurrent auto-run tasks the signal is shared across them. Most
 * collaborations have one active task per worker at a time; per-task fingerprints
 * are a later refinement.
 */
export function productFingerprint(doc: CollabDoc, ownerLabel: string): string {
  const section = doc.progress.find((p) => p.agent === ownerLabel);
  if (!section || section.entries.length === 0) return 'none';
  return `${section.entries.length}|${section.entries[section.entries.length - 1]}`;
}

/** States the loop keeps driving. Everything else (done/blocked/needs-decision/failed) is left alone. */
const ACTIVE_STATES = new Set(['assigned', 'working']);

/**
 * Decide what a single auto-run tick should do for one task. Pure: no clock of
 * its own, no I/O. `currentFp` is `productFingerprint(doc, task.owner)` computed
 * by the caller. `now` is epoch ms.
 */
export function decideTick(
  task: CollabTask,
  currentFp: string,
  { now, config }: { now: number; config: AutoRunConfig },
): AutoRunAction {
  if (!task.autoRun) return { kind: 'skip', reason: 'not-auto-run' };
  if (!ACTIVE_STATES.has(task.state)) return { kind: 'skip', reason: `state:${task.state}` };

  // Failsafe first: a mis-judged loop must not outrun the ceiling.
  if (task.startedAt) {
    const ranForMs = now - Date.parse(task.startedAt);
    if (Number.isFinite(ranForMs) && ranForMs > config.maxWallClockSec * 1000) {
      return { kind: 'backstop', ranForMs };
    }
  }

  // Product moved since last tick → keep the worker going.
  if (currentFp !== (task.productFingerprint ?? '')) {
    return { kind: 'advance', fingerprint: currentFp };
  }

  // No product this tick. Self-retry up to the budget, then hand to the lead.
  const stalls = (task.stallCount ?? 0) + 1;
  if (stalls <= config.maxRetries) return { kind: 'retry', attempt: stalls };
  return { kind: 'judge', stalls };
}
