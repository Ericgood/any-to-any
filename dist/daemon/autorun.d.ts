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
export declare const DEFAULT_AUTORUN_CONFIG: AutoRunConfig;
export type AutoRunAction = 
/** Not eligible this tick (not auto-run, terminal/paused state, …). */
{
    kind: 'skip';
    reason: string;
}
/** Product moved forward → nudge the worker to do the next chunk; reset stall. */
 | {
    kind: 'advance';
    fingerprint: string;
}
/** No product yet, still within the self-retry budget → nudge the worker again. */
 | {
    kind: 'retry';
    attempt: number;
}
/** Stalled past the budget → ask the LEAD to judge (redirect or escalate). */
 | {
    kind: 'judge';
    stalls: number;
}
/** Wall-clock ceiling hit → daemon failsafe escalate to the operator. */
 | {
    kind: 'backstop';
    ranForMs: number;
};
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
export declare function productFingerprint(doc: CollabDoc, ownerLabel: string): string;
/**
 * Decide what a single auto-run tick should do for one task. Pure: no clock of
 * its own, no I/O. `currentFp` is `productFingerprint(doc, task.owner)` computed
 * by the caller. `now` is epoch ms.
 */
export declare function decideTick(task: CollabTask, currentFp: string, { now, config }: {
    now: number;
    config: AutoRunConfig;
}): AutoRunAction;
