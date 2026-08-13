import type { Mailbox } from '../mailbox/mailbox.js';
export interface PromptHookInput {
    session_id?: string;
    thread_id?: string;
}
export interface PromptHookOutput {
    hookSpecificOutput?: {
        hookEventName: 'UserPromptSubmit';
        additionalContext: string;
    };
}
/**
 * Collect what a session should see right now: pending messages fully injected
 * (and taken), plus an FYI digest of traffic already handled in headless turns
 * since the last cursor. Returns the combined text, or null when nothing is new.
 * Shared by the prompt hook (Claude/Codex UserPromptSubmit) and `anyd pull` (the
 * manual reload for interactive apps that don't live-refresh from disk).
 */
export declare function collectInbox(mailbox: Mailbox, sessionId: string, opts?: {
    home?: string;
    now?: () => number;
}): string | null;
/**
 * Full recent cross-agent exchange for a session — read-only, ignores the cursor,
 * takes nothing. This is the "let me SEE what happened" view: once a message is
 * delivered (headlessly) and the cursor moves past it, `collectInbox` won't show
 * it again, but the live app never displayed it either. `anyd pull --history`
 * uses this to pull the whole recent exchange (both directions, including failed/
 * dead messages) back into the live session on demand.
 */
export declare function recentExchange(mailbox: Mailbox, sessionId: string, limit?: number): string | null;
/**
 * Shared UserPromptSubmit processor for Claude Code and Codex (same output shape).
 * Two layers: pending messages are fully injected (and taken); already-handled
 * traffic since the last cursor is shown as an FYI digest — this is what makes
 * headless cross-agent activity visible inside the vendor app's own chat flow.
 */
export declare function processPromptHook(mailbox: Mailbox, input: PromptHookInput, opts?: {
    home?: string;
    now?: () => number;
}): PromptHookOutput;
/** Backwards-compatible existence check used by doctor. */
export declare function hookCursorDirExists(home?: string): boolean;
