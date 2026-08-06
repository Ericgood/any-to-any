import type { Db } from './db.js';
export interface SessionRef {
    agent: string;
    sessionId: string;
    /** Device name for remote refs; unset = this machine. */
    device?: string;
}
export interface MessagePart {
    type: 'text';
    text: string;
    via?: string;
}
export type MessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';
export interface Message {
    id: string;
    conversationId: string;
    contextId: string;
    from: SessionRef;
    to: SessionRef;
    parts: MessagePart[];
    status: MessageStatus;
    attempts: number;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
}
export interface ConversationSummary {
    id: string;
    a: SessionRef;
    b: SessionRef;
    createdAt: number;
    lastMessageAt: number;
    messageCount: number;
    lastMessage?: Message;
}
export interface SendInput {
    from: SessionRef;
    to: SessionRef;
    text: string;
    contextId?: string;
    via?: string;
}
export interface InboxQuery {
    toSession?: string;
    take?: boolean;
    all?: boolean;
    /** Only strictly-pending messages — excludes 'delivering' (dispatcher-owned) and 'failed'. */
    pendingOnly?: boolean;
}
export interface Mailbox {
    send(input: SendInput): Message;
    reply(messageId: string, text: string, via?: string): Message;
    inbox(query?: InboxQuery): Message[];
    getMessage(id: string): Message | null;
    listConversations(): ConversationSummary[];
    listMessages(conversationId: string): Message[];
    claimNextPending(): Message | null;
    markDelivered(id: string): Message;
    markFailed(id: string, error: string): Message;
    retry(id: string): Message;
    /** Requeue messages stranded in 'delivering' by a crashed daemon (at-least-once). */
    recoverStale(): number;
    /** All traffic touching a session (either direction) since a timestamp — for visibility digests. */
    recentActivity(sessionId: string, sinceMs: number, limit?: number): Message[];
}
export declare function createMailbox(db: Db, opts?: {
    now?: () => number;
}): Mailbox;
