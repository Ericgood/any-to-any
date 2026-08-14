import { resolveTarget } from '../directory/resolve.js';
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
// ───────────────────────── daemon wiring ─────────────────────────
// The clock around the pure core: read every auto-run task, resolve its owner,
// gate on live-monitor / cross-device, decide, and act (nudge the worker, ask
// the lead to judge, or escalate to the operator). Bookkeeping (fingerprint,
// stall count, startedAt) is persisted back to the shared doc as the lead.
const USER_CLI = { agent: 'user', sessionId: 'cli' };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(n)));
export function resolveAutoRunConfig(c) {
    return {
        enabled: c?.enabled ?? true,
        tickIntervalSec: clamp(c?.tickIntervalSec ?? 60, 15, 600),
        maxRetries: clamp(c?.maxRetries ?? DEFAULT_AUTORUN_CONFIG.maxRetries, 0, 10),
        maxWallClockSec: clamp(c?.maxWallClockSec ?? DEFAULT_AUTORUN_CONFIG.maxWallClockSec, 60, 86400),
    };
}
const isLocal = (device, selfDevice) => !device || device === (selfDevice ?? '');
const refFromSession = (s) => {
    const ref = { agent: s.agent, sessionId: s.sessionId };
    if (s.device)
        ref.device = s.device;
    return ref;
};
function workerNudge(conversationId, task, mode) {
    const log = `anyd collab progress ${conversationId} --as "${task.owner}" "<what you did + next>"`;
    if (mode === 'retry') {
        return [
            `Task ${task.id}: last round logged no new product on the shared plan.`,
            `Take a DIFFERENT approach and finish one concrete chunk this turn (wrote <file> / <sha> / n/m), then log it: ${log}.`,
            `If you're genuinely stuck, reply BLOCKED <exactly what's missing>. Do not just acknowledge and wait.`,
        ].join(' ');
    }
    return [
        `Continue task ${task.id}${task.step ? ` (${task.step})` : ''} on the shared plan (anyd collab show ${conversationId}).`,
        `Do the next chunk you can finish this turn, then log the concrete product: ${log}.`,
        `If you can't proceed, reply BLOCKED <what's missing>. Do not reply "received" and wait for the next message.`,
    ].join(' ');
}
function leadJudgeNudge(conversationId, task, stalls) {
    return [
        `You are the lead. Task ${task.id} (owner ${task.owner}) has logged no new product for ${stalls} rounds`,
        `on the shared plan (anyd collab show ${conversationId}). Judge by product, not by promises:`,
        `either (a) reply to ${task.owner} with a concrete new direction to unblock it,`,
        `or (b) if it's genuinely stuck or the approach is wrong, summarize for the operator`,
        `(goal / what's done / where it's stuck / the decision you need) and send it:`,
        `anyd send "@user:cli" "<summary>" --from "<your label>". Don't leave it spinning.`,
    ].join(' ');
}
function operatorEscalation(conversationId, task, reason) {
    return [
        `[anytoany self-driving loop] Task ${task.id} (owner ${task.owner}) ${reason}.`,
        `Auto-driving is paused (task set to needs-decision). Review: anyd collab show ${conversationId}. Your call on how to proceed.`,
    ].join(' ');
}
/**
 * One sweep over every auto-run task. Returns the number of actions taken.
 * Pure-ish: all I/O goes through the injected `collab` / `mailbox` / `directory`
 * / `isMonitored`, so it drives cleanly under test with in-memory stubs.
 */
export async function runAutoRunOnce(opts) {
    const config = resolveAutoRunConfig(opts.config);
    if (!config.enabled)
        return 0;
    const nowMs = opts.now ? opts.now() : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const sessions = await opts.directory();
    let acted = 0;
    for (const doc of opts.collab.list()) {
        for (const task of doc.tasks) {
            if (!task.autoRun)
                continue;
            if (task.state !== 'assigned' && task.state !== 'working')
                continue;
            const owner = resolveTarget(task.owner, sessions);
            if (!owner.ok) {
                opts.onEvent?.({ kind: 'error', conversationId: doc.conversationId, taskId: task.id, detail: `owner unresolved: ${owner.reason}` });
                continue;
            }
            if (!isLocal(owner.session.device, opts.selfDevice))
                continue; // v1: same-machine only
            if (opts.isMonitored(owner.session.sessionId))
                continue; // live-monitored → don't double-drive
            const started = task.startedAt ?? nowIso; // stamp the backstop base on first drive
            const currentFp = productFingerprint(doc, task.owner);
            const decision = decideTick({ ...task, startedAt: started }, currentFp, { now: nowMs, config });
            if (decision.kind === 'skip')
                continue;
            acted++;
            const conversationId = doc.conversationId;
            const known = opts.mailbox.listConversations().some((c) => c.id === conversationId);
            const pin = known ? { conversationId } : {};
            const ownerRef = refFromSession(owner.session);
            const persist = (patch) => opts.collab.upsertTask(conversationId, doc.lead, {
                ...task,
                ...patch,
                startedAt: started,
                lastTickAt: nowIso,
                updated: nowIso,
            });
            if (decision.kind === 'advance') {
                opts.mailbox.send({ from: USER_CLI, to: ownerRef, text: workerNudge(conversationId, task, 'advance'), via: 'autorun', ...pin });
                await persist({ productFingerprint: decision.fingerprint, stallCount: 0 });
                opts.onEvent?.({ kind: 'advance', conversationId, taskId: task.id });
            }
            else if (decision.kind === 'retry') {
                opts.mailbox.send({ from: USER_CLI, to: ownerRef, text: workerNudge(conversationId, task, 'retry'), via: 'autorun', ...pin });
                await persist({ stallCount: decision.attempt });
                opts.onEvent?.({ kind: 'retry', conversationId, taskId: task.id, detail: `attempt ${decision.attempt}` });
            }
            else if (decision.kind === 'judge') {
                const lead = resolveTarget(doc.lead, sessions);
                if (lead.ok && isLocal(lead.session.device, opts.selfDevice)) {
                    opts.mailbox.send({ from: USER_CLI, to: refFromSession(lead.session), text: leadJudgeNudge(conversationId, task, decision.stalls), via: 'autorun', ...pin });
                    await persist({ stallCount: 0 }); // fresh patience budget after asking the lead
                    opts.onEvent?.({ kind: 'judge', conversationId, taskId: task.id });
                }
                else {
                    // no reachable lead to judge → go straight to the operator
                    opts.mailbox.send({ from: ownerRef, to: USER_CLI, text: operatorEscalation(conversationId, task, `stalled ${decision.stalls} rounds with no reachable lead to judge`), via: 'autorun-escalate' });
                    await persist({ state: 'needs-decision' });
                    opts.onEvent?.({ kind: 'judge', conversationId, taskId: task.id, detail: 'no-lead→operator' });
                }
            }
            else {
                // backstop: dumb wall-clock failsafe → escalate to the operator
                const mins = Math.round(decision.ranForMs / 60000);
                opts.mailbox.send({ from: ownerRef, to: USER_CLI, text: operatorEscalation(conversationId, task, `hit the ${mins}-min ceiling without completing`), via: 'autorun-escalate' });
                await persist({ state: 'needs-decision' });
                opts.onEvent?.({ kind: 'backstop', conversationId, taskId: task.id, detail: `${mins}min` });
            }
        }
    }
    return acted;
}
/** Start the self-driving clock: sweep every `tickIntervalSec`. Returns `stop()`. */
export function startAutoRun(opts, { intervalMs } = {}) {
    const config = resolveAutoRunConfig(opts.config);
    const cadence = intervalMs ?? config.tickIntervalSec * 1000;
    let stopped = false;
    let timer;
    const tick = async () => {
        if (stopped)
            return;
        try {
            await runAutoRunOnce(opts);
        }
        catch (e) {
            opts.onEvent?.({ kind: 'error', conversationId: '', taskId: '', detail: e instanceof Error ? e.message : String(e) });
        }
        if (!stopped)
            timer = setTimeout(() => void tick(), cadence);
    };
    if (config.enabled)
        timer = setTimeout(() => void tick(), cadence);
    return {
        stop: () => {
            stopped = true;
            if (timer)
                clearTimeout(timer);
        },
    };
}
//# sourceMappingURL=autorun.js.map