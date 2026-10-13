import type { Mailbox } from '../mailbox/mailbox.js';
/**
 * The Claude doorbell (ADR-027).
 *
 * Claude Code v2.1.224+ gives every session — desktop App ones included — a local
 * inbox: a Unix socket registered in `~/.claude/sessions/<pid>.json`. A line written
 * to it makes an idle session start a turn (a busy one reads it between tool calls),
 * and that turn fires UserPromptSubmit, i.e. anytoany's existing pull hook.
 *
 * So the doorbell carries NO message content — just "you have mail". The message
 * stays pending in the mailbox and the hook injects it with the usual framing and
 * `anyd reply` path. If the frame is held (a bypass-mode receiver without
 * `crossSessionInbound: accept`) or lost, nothing is lost: the hook still delivers
 * it on the user's next prompt — the pre-ADR-027 behaviour.
 *
 * We never read the `<pid>.*.key` tokens next to the registry: a token would make
 * the frame count as the session's own child and skip its inbound controls.
 * Verified live on 2.1.296, 2026-10-13. The wire format is the community-captured
 * one (agents-can-communicate #130), not an official spec — hence fail-soft.
 */
export interface InboxEntry {
    pid: number;
    sessionId: string;
    socketPath: string;
    status?: string;
    version?: string;
}
export interface InboxRegistryOptions {
    /** `~/.claude/sessions` */
    dir?: string;
    isAlive?: (pid: number) => boolean;
    ttlMs?: number;
    now?: () => number;
}
/** Cached probe: sessionId → inbox, for Claude sessions that are running right now. */
export declare function createClaudeInboxRegistry(options?: InboxRegistryOptions): () => Map<string, InboxEntry>;
/** One newline-terminated inbox frame: "you have mail", never the mail itself. */
export declare function buildDoorbellFrame(input: {
    messageIds: string[];
    fromLabel: string;
}): string;
/** Write one frame to a session's inbox socket. Never throws. */
export declare function ringInbox(socketPath: string, frame: string, timeoutMs?: number): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Will a ring actually wake anyone? Verified 2026-10-13: with the user-level default
 * `permissions.defaultMode: "bypassPermissions"` and no `crossSessionInbound`, every
 * session holds the frame (`peer_message_hold`, cause `no-mode-asserted`) and the
 * desktop App can't show the approval dialog — the ring only leaves held notices
 * behind. In that configuration we don't ring at all; the pull hook delivers on the
 * next prompt exactly as before. An explicit `accept` (or a prompting default) rings.
 */
export declare function doorbellUseful(settings: {
    crossSessionInbound?: unknown;
    permissions?: {
        defaultMode?: unknown;
    };
} | null): boolean;
export interface DoorbellEvent {
    kind: 'rung' | 'ring-failed';
    sessionId: string;
    messageIds: string[];
    detail?: string;
}
export interface DoorbellOptions {
    mailbox: Mailbox;
    inboxes: () => Map<string, InboxEntry>;
    ring?: (socketPath: string, frame: string) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    onEvent?: (event: DoorbellEvent) => void;
    /** Gate re-read each tick (cheap): false = don't ring, see doorbellUseful. */
    enabled?: () => boolean;
}
/**
 * Each tick: pending mail addressed to a running local Claude session gets ONE
 * ring per batch. A message is rung at most once (success or not) — the pull hook
 * is the safety net, so a dead socket must never turn into a ring storm.
 */
export declare function createDoorbell(opts: DoorbellOptions): {
    tick(): Promise<void>;
};
/** Shared registry instance for the daemon (liveness + doorbell). */
export declare const liveClaudeInboxes: () => Map<string, InboxEntry>;
