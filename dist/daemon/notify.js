import { spawn } from 'node:child_process';
const THROTTLE_MS = 60_000;
/** One mismatch alert per agent per window — it stays broken until upgraded, no need to nag per message. */
const MISMATCH_THROTTLE_MS = 10 * 60_000;
const DETAIL_MAX = 220;
/** Post a macOS notification (no-op elsewhere or when disabled). */
function postNotification(title, body) {
    if (process.platform !== 'darwin')
        return;
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const child = spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], {
        stdio: 'ignore',
        detached: true,
    });
    child.unref();
    child.on('error', () => {
        /* notification is best-effort — never break delivery over it */
    });
}
export function createNotifier(opts = { enabled: true }) {
    const lastPerSession = new Map();
    const lastMismatchPerAgent = new Map();
    const now = opts.now ?? Date.now;
    return {
        versionMismatch(agent, detail) {
            if (!opts.enabled)
                return;
            const ts = now();
            if (ts - (lastMismatchPerAgent.get(agent) ?? -Infinity) < MISMATCH_THROTTLE_MS)
                return;
            lastMismatchPerAgent.set(agent, ts);
            const upgrade = /upgrade: (.+?) —/.exec(detail)?.[1];
            postNotification(`anytoany — ${agent} CLI out of date, message NOT delivered`, upgrade ? `Run: ${upgrade}` : detail.slice(0, DETAIL_MAX));
        },
        sessionActivity(agent, sessionTitle, sessionId, direction) {
            if (!opts.enabled)
                return;
            const ts = now();
            const last = lastPerSession.get(sessionId) ?? 0;
            if (ts - last < THROTTLE_MS)
                return;
            lastPerSession.set(sessionId, ts);
            const verb = direction === 'received' ? 'received a new message' : 'sent a reply';
            postNotification('anytoany', `@${agent}:${sessionTitle} ${verb} — reopen the session to see it (or the console at 127.0.0.1:7433)`);
        },
    };
}
//# sourceMappingURL=notify.js.map