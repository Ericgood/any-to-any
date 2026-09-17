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
export declare function startExternalInboxNotifier(opts: ExternalInboxNotifierOptions): ExternalInboxNotifier;
