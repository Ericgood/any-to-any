export const DEFAULT_AUTORUN_CONFIG = {
    maxRetries: 2,
    maxWallClockSec: 3600,
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
export function productFingerprint(doc, ownerLabel) {
    const section = doc.progress.find((p) => p.agent === ownerLabel);
    if (!section || section.entries.length === 0)
        return 'none';
    return `${section.entries.length}|${section.entries[section.entries.length - 1]}`;
}
/** States the loop keeps driving. Everything else (done/blocked/needs-decision/failed) is left alone. */
const ACTIVE_STATES = new Set(['assigned', 'working']);
/**
 * Decide what a single auto-run tick should do for one task. Pure: no clock of
 * its own, no I/O. `currentFp` is `productFingerprint(doc, task.owner)` computed
 * by the caller. `now` is epoch ms.
 */
export function decideTick(task, currentFp, { now, config }) {
    if (!task.autoRun)
        return { kind: 'skip', reason: 'not-auto-run' };
    if (!ACTIVE_STATES.has(task.state))
        return { kind: 'skip', reason: `state:${task.state}` };
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
    if (stalls <= config.maxRetries)
        return { kind: 'retry', attempt: stalls };
    return { kind: 'judge', stalls };
}
//# sourceMappingURL=autorun.js.map