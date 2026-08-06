import { spawn } from 'node:child_process';
const THROTTLE_MS = 60_000;
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
    const now = opts.now ?? Date.now;
    return {
        sessionActivity(agent, sessionTitle, sessionId, direction) {
            if (!opts.enabled)
                return;
            const ts = now();
            const last = lastPerSession.get(sessionId) ?? 0;
            if (ts - last < THROTTLE_MS)
                return;
            lastPerSession.set(sessionId, ts);
            const verb = direction === 'received' ? '收到新消息' : '发出了回复';
            postNotification('anytoany', `@${agent}:${sessionTitle} ${verb} — 重新打开该会话可见（或看控制台 127.0.0.1:7433）`);
        },
    };
}
//# sourceMappingURL=notify.js.map