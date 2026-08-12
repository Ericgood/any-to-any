import { spawn } from 'node:child_process';

export interface Notifier {
  /** Notify the user that a session got new cross-agent traffic. Throttled per session. */
  sessionActivity(agent: string, sessionTitle: string, sessionId: string, direction: 'received' | 'replied'): void;
}

const THROTTLE_MS = 60_000;

/** Post a macOS notification (no-op elsewhere or when disabled). */
function postNotification(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const child = spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  child.on('error', () => {
    /* notification is best-effort — never break delivery over it */
  });
}

export function createNotifier(opts: { enabled: boolean; now?: () => number } = { enabled: true }): Notifier {
  const lastPerSession = new Map<string, number>();
  const now = opts.now ?? Date.now;
  return {
    sessionActivity(agent, sessionTitle, sessionId, direction) {
      if (!opts.enabled) return;
      const ts = now();
      const last = lastPerSession.get(sessionId) ?? 0;
      if (ts - last < THROTTLE_MS) return;
      lastPerSession.set(sessionId, ts);
      const verb = direction === 'received' ? 'received a new message' : 'sent a reply';
      postNotification(
        'anytoany',
        `@${agent}:${sessionTitle} ${verb} — reopen the session to see it (or the console at 127.0.0.1:7433)`,
      );
    },
  };
}
