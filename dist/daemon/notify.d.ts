export interface Notifier {
    /** Notify the user that a session got new cross-agent traffic. Throttled per session. */
    sessionActivity(agent: string, sessionTitle: string, sessionId: string, direction: 'received' | 'replied'): void;
}
export declare function createNotifier(opts?: {
    enabled: boolean;
    now?: () => number;
}): Notifier;
