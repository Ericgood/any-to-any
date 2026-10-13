import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DEFAULT_TTL_MS = 2_000;
const RING_TIMEOUT_MS = 3_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        // ESRCH = gone; EPERM = another user's process — not one of our sessions either way
        return false;
    }
}
function parseEntry(raw) {
    try {
        const d = JSON.parse(raw);
        const { pid, sessionId, messagingSocketPath, status, version } = d;
        if (typeof pid !== 'number' || typeof sessionId !== 'string' || !UUID_RE.test(sessionId))
            return null;
        if (typeof messagingSocketPath !== 'string' || !messagingSocketPath)
            return null;
        return {
            pid,
            sessionId,
            socketPath: messagingSocketPath,
            ...(typeof status === 'string' ? { status } : {}),
            ...(typeof version === 'string' ? { version } : {}),
        };
    }
    catch {
        return null;
    }
}
/** Cached probe: sessionId → inbox, for Claude sessions that are running right now. */
export function createClaudeInboxRegistry(options = {}) {
    const dir = options.dir ?? join(homedir(), '.claude', 'sessions');
    const isAlive = options.isAlive ?? pidAlive;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const now = options.now ?? Date.now;
    let cached = null;
    return () => {
        const t = now();
        if (cached && t - cached.at < ttlMs)
            return cached.map;
        const map = new Map();
        let names = [];
        try {
            names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
        }
        catch {
            // no ~/.claude/sessions — Claude Code too old or not installed
        }
        for (const name of names) {
            let raw;
            try {
                raw = readFileSync(join(dir, name), 'utf8');
            }
            catch {
                continue;
            }
            const entry = parseEntry(raw);
            // a crashed session leaves its file behind — require a live pid AND the socket
            if (entry && isAlive(entry.pid) && existsSync(entry.socketPath))
                map.set(entry.sessionId, entry);
        }
        cached = { at: t, map };
        return map;
    };
}
/** One newline-terminated inbox frame: "you have mail", never the mail itself. */
export function buildDoorbellFrame(input) {
    const n = input.messageIds.length;
    const content = [
        `[anytoany] Doorbell: ${n} new cross-agent message${n === 1 ? '' : 's'} for this session (from ${input.fromLabel}).`,
        `The anytoany inbox hook attaches ${n === 1 ? 'it' : 'them'} to this turn — handle ${n === 1 ? 'it' : 'them'} there.`,
        `If nothing from anytoany is attached, run: anyd pull`,
    ].join('\n');
    const frame = {
        type: 'user',
        message: { role: 'user', content },
        msg_id: `anytoany-${input.messageIds[0] ?? 'wake'}`,
        priority: 'next',
    };
    return `${JSON.stringify(frame)}\n`;
}
/** Write one frame to a session's inbox socket. Never throws. */
export function ringInbox(socketPath, frame, timeoutMs = RING_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(r);
        };
        const socket = createConnection(socketPath);
        const timer = setTimeout(() => done({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
        socket.on('error', (e) => done({ ok: false, error: e.message }));
        socket.on('connect', () => {
            socket.end(frame, () => done({ ok: true }));
        });
    });
}
/**
 * Will a ring actually wake anyone? Verified 2026-10-13: with the user-level default
 * `permissions.defaultMode: "bypassPermissions"` and no `crossSessionInbound`, every
 * session holds the frame (`peer_message_hold`, cause `no-mode-asserted`) and the
 * desktop App can't show the approval dialog — the ring only leaves held notices
 * behind. In that configuration we don't ring at all; the pull hook delivers on the
 * next prompt exactly as before. An explicit `accept` (or a prompting default) rings.
 */
export function doorbellUseful(settings) {
    if (settings?.crossSessionInbound === 'accept')
        return true;
    if (settings?.crossSessionInbound === 'refuse' || settings?.crossSessionInbound === 'hold')
        return false;
    return settings?.permissions?.defaultMode !== 'bypassPermissions';
}
/**
 * Each tick: pending mail addressed to a running local Claude session gets ONE
 * ring per batch. A message is rung at most once (success or not) — the pull hook
 * is the safety net, so a dead socket must never turn into a ring storm.
 */
export function createDoorbell(opts) {
    const ring = opts.ring ?? ringInbox;
    const rung = new Set();
    return {
        async tick() {
            if (opts.enabled && !opts.enabled())
                return;
            const inboxes = opts.inboxes();
            if (inboxes.size === 0)
                return;
            const waiting = new Map();
            for (const m of opts.mailbox.inbox({ pendingOnly: true })) {
                if (m.to.agent !== 'claude' || m.to.device || rung.has(m.id) || !inboxes.has(m.to.sessionId))
                    continue;
                const batch = waiting.get(m.to.sessionId) ?? { ids: [], from: `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}` };
                waiting.set(m.to.sessionId, { ...batch, ids: [...batch.ids, m.id] });
            }
            for (const [sessionId, { ids, from }] of waiting) {
                const inbox = inboxes.get(sessionId);
                if (!inbox)
                    continue;
                for (const id of ids)
                    rung.add(id);
                const r = await ring(inbox.socketPath, buildDoorbellFrame({ messageIds: ids, fromLabel: from }));
                opts.onEvent?.(r.ok
                    ? { kind: 'rung', sessionId, messageIds: ids }
                    : { kind: 'ring-failed', sessionId, messageIds: ids, detail: r.error ?? 'unknown error' });
            }
        },
    };
}
/** Shared registry instance for the daemon (liveness + doorbell). */
export const liveClaudeInboxes = createClaudeInboxRegistry();
//# sourceMappingURL=claude-inbox.js.map