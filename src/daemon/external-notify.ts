import type { Mailbox } from '../mailbox/mailbox.js';
import type { ExternalSession } from '../registry/external.js';
import type { Notifier } from './notify.js';

/**
 * Tell the operator when mail arrives for a registered external agent (ADR-024).
 *
 * A pull-only session's messages are never claimed by the dispatcher, so they
 * never emit a `delivered` event — and the normal notifier hangs off exactly
 * that event (cli.ts). Worse, a desktop-App assistant like 闪电说 has NO self-
 * drive: it cannot poll, and nothing wakes it until the user speaks. So the OS
 * notification is the wake-up signal: "there's a reply — go ask it".
 */
export interface ExternalInboxNotifier {
  /** Run one scan (exposed for tests and for an immediate first pass). */
  tick(): void;
  stop(): void;
}

export interface ExternalInboxNotifierOptions {
  mailbox: Pick<Mailbox, 'inbox'>;
  listRegistered: () => ExternalSession[];
  notifier: Notifier;
  intervalMs?: number;
  /** false = do not arm the timer (tests drive `tick()` directly). */
  autoStart?: boolean;
  /** Called for each announcement, so the daemon log shows it happened. */
  onNotify?: (session: ExternalSession, messageId: string) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;

export function startExternalInboxNotifier(opts: ExternalInboxNotifierOptions): ExternalInboxNotifier {
  const announced = new Set<string>();

  const pendingFor = (sessionId: string): Array<{ id: string }> => {
    try {
      return opts.mailbox.inbox({ toSession: sessionId, pendingOnly: true });
    } catch {
      // A transient read error must not kill the daemon's notification loop.
      return [];
    }
  };

  /** Everything already waiting when we start is backlog, not news — otherwise a
   *  daemon restart replays every message the agent has not fetched yet. */
  for (const session of safeList()) {
    for (const m of pendingFor(session.sessionId)) announced.add(m.id);
  }

  function safeList(): ExternalSession[] {
    try {
      return opts.listRegistered();
    } catch {
      return [];
    }
  }

  const tick = (): void => {
    for (const session of safeList()) {
      for (const m of pendingFor(session.sessionId)) {
        if (announced.has(m.id)) continue;
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
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
}
