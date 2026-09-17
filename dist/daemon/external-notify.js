const DEFAULT_INTERVAL_MS = 5_000;
export function startExternalInboxNotifier(opts) {
    const announced = new Set();
    const pendingFor = (sessionId) => {
        try {
            return opts.mailbox.inbox({ toSession: sessionId, pendingOnly: true });
        }
        catch {
            // A transient read error must not kill the daemon's notification loop.
            return [];
        }
    };
    /** Everything already waiting when we start is backlog, not news — otherwise a
     *  daemon restart replays every message the agent has not fetched yet. */
    for (const session of safeList()) {
        for (const m of pendingFor(session.sessionId))
            announced.add(m.id);
    }
    function safeList() {
        try {
            return opts.listRegistered();
        }
        catch {
            return [];
        }
    }
    const tick = () => {
        for (const session of safeList()) {
            for (const m of pendingFor(session.sessionId)) {
                if (announced.has(m.id))
                    continue;
                announced.add(m.id);
                opts.notifier.sessionActivity(session.agent, session.title, session.sessionId, 'received');
                opts.onNotify?.(session, m.id);
            }
        }
    };
    const timer = opts.autoStart === false ? null : setInterval(tick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    timer?.unref?.();
    return {
        tick,
        stop() {
            if (timer)
                clearInterval(timer);
        },
    };
}
//# sourceMappingURL=external-notify.js.map