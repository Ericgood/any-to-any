export interface Notifier {
    /** Notify the user that a session got new cross-agent traffic. Throttled per session. */
    sessionActivity(agent: string, sessionTitle: string, sessionId: string, direction: 'received' | 'replied'): void;
    /** Loud alert: delivery to `agent` was refused because its CLI is out of date (ADR-025). */
    versionMismatch(agent: string, detail: string): void;
}
export declare function createNotifier(opts?: {
    enabled: boolean;
    now?: () => number;
}): Notifier;
