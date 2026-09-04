import { execFileSync } from 'node:child_process';
/**
 * Detect Claude sessions that are currently open in an INTERACTIVE process, so the
 * dispatcher does not headless-`claude -p --resume` into them (ADR-023).
 *
 * Why this matters (verified 2026-09-05 with real mailbox + transcript evidence):
 * resume-delivering into a live Claude session makes the injected turn physically
 * land in the transcript, yet `claude -p` still exits non-zero — a post-turn hook
 * chokes on a huge transcript ("Hook cancelled"), or the exit is simply 1 with an
 * empty stderr when a second process shares the session. Either way anytoany
 * false-failed and retried 3×, re-injecting duplicate turns into the session the
 * operator was actively using, before dead-lettering a message that had already
 * arrived. Live sessions are surfaced instead by their own pull hook / `anyd
 * monitor`, so the right move is to leave the message pending — exactly what we
 * already do for a monitored session (see monitor.ts).
 *
 * The interactive form is `--resume=<uuid>` (an `=`); our own headless delivery is
 * `--resume <uuid>` (a space), so matching the `=` form never matches a delivery.
 */
const UUID = /--resume=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
/** Pure: extract interactively-open Claude session ids from `ps` command output. */
export function parseLiveClaudeSessions(psOutput) {
    const ids = new Set();
    for (const match of psOutput.matchAll(UUID)) {
        if (match[1])
            ids.add(match[1]);
    }
    return ids;
}
const TTL_MS = 2_000;
let cache = null;
/**
 * Session ids currently open in an interactive Claude process. Cached briefly so
 * the dispatch hot path can call it cheaply and synchronously. Best-effort: any
 * failure (no `ps`, not permitted, non-macOS/Linux) yields an empty set, so
 * delivery falls back to the normal resume path rather than blocking.
 */
export function liveClaudeSessions(now = Date.now) {
    const t = now();
    if (cache && t - cache.at < TTL_MS)
        return cache.ids;
    let ids = new Set();
    try {
        const out = execFileSync('ps', ['-axww', '-o', 'command'], { encoding: 'utf8', timeout: 4_000 });
        ids = parseLiveClaudeSessions(out);
    }
    catch {
        // no `ps` / not permitted — treat as "nothing known live"
    }
    cache = { at: t, ids };
    return ids;
}
/** Is this session open in an interactive Claude process right now? */
export function isSessionLive(sessionId, now = Date.now) {
    return liveClaudeSessions(now).has(sessionId);
}
//# sourceMappingURL=session-liveness.js.map