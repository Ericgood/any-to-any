import type { DeliveryAdapter, SessionInfo } from '../adapters/types.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
export interface DispatchEvent {
    kind: 'delivered' | 'failed' | 'reply-filed' | 'reply-rejected';
    message: Message;
    detail?: string;
}
export interface DispatcherOptions {
    mailbox: Mailbox;
    /** agent name -> delivery adapter */
    adapters: Map<string, DeliveryAdapter>;
    /** Session directory supplier (cached by the caller as needed). */
    directory: () => Promise<SessionInfo[]>;
    onEvent?: (event: DispatchEvent) => void;
    /** This machine's device name; unset disables relay routing (Phase 1 mode). */
    selfDevice?: string;
    /** Hand a message to a paired peer daemon (Phase 2 LAN). */
    relay?: (device: string, message: Message) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** When set and a doc exists for the conversation, the delivery envelope
     *  points the recipient at the shared collaboration plan (Phase 4). `ensure`,
     *  when present, lets the first agent↔agent message auto-create a seeded doc
     *  (ADR-018 — the plan is born with the connection). */
    collab?: {
        exists(conversationId: string): boolean;
        ensure?(input: {
            conversationId: string;
            lead: string;
            body?: string;
        }): Promise<unknown>;
    };
    /** A local session actively running `anyd monitor` receives messages live in its
     *  own turn; the dispatcher must NOT resume-deliver to it (which would create an
     *  invisible headless turn). Such messages stay pending for the monitor to pull. */
    isMonitored?: (sessionId: string) => boolean;
    /** A local Claude session open in an interactive process must also NOT be
     *  resume-delivered to: the injected turn lands but `claude -p` exits non-zero
     *  (a post-turn hook chokes, or the shared session errors), so anytoany false-
     *  fails and retries — re-injecting duplicate turns into the session the operator
     *  is actively using. Leave it pending; its own prompt hook surfaces it (ADR-023). */
    isSessionLive?: (sessionId: string) => boolean;
    /** A registered EXTERNAL agent session (ADR-024) — a desktop App's assistant
     *  such as 闪电说, which anytoany has no delivery adapter for. It pulls its own
     *  mail over the daemon's HTTP inbox, so its messages must stay pending rather
     *  than be claimed and dead-lettered for want of an adapter. */
    isPullOnly?: (sessionId: string) => boolean;
}
/** Claim and deliver a single message. Returns false when nothing was pending. */
export declare function dispatchOnce(opts: DispatcherOptions): Promise<boolean>;
export interface RunningDispatcher {
    stop(): void;
}
/** Poll the mailbox forever; drains the queue then idles at intervalMs. */
export declare function startDispatcher(opts: DispatcherOptions, { intervalMs }?: {
    intervalMs?: number;
}): RunningDispatcher;
