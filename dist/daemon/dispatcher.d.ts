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
     *  points the recipient at the shared collaboration plan (Phase 4). */
    collab?: {
        exists(conversationId: string): boolean;
    };
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
