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
