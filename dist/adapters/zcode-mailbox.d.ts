/**
 * ZCode's native session mailbox (ADR-029). Unpublished, behind
 * ZCODE_MESSAGE_ENABLED=1; read from ZCode's open-source runtime
 * (apps/zcode-cli/packages/core/src/hooks/session-mailbox.ts) and verified live
 * against CLI 0.16.5. A flagged runtime drains `<root>/<sess>/unread/*.json` at
 * UserPromptSubmit, PostToolUse (into the running turn) and Stop (then continues).
 */
export interface MailboxEnvelope {
    messageId: string;
    fromSessionId: string;
    toSessionId: string;
    content: string;
    createdAt: string;
}
export declare function mailboxRoot(env?: NodeJS.ProcessEnv, home?: string): string;
/**
 * A flagged runtime `mkdir -p`s the session's unread/ on every drain (each turn
 * starts with one), so its existence is ZCode's own trace that this session runs
 * with the mailbox on. We can't ask the process: ZCode renames itself to
 * `zcode-cli`, which overwrites the memory `ps eww` would read its env from.
 */
export declare function mailboxEnabledFor(root: string, sessionId: string): boolean;
/** Write a version-1 envelope into unread/ atomically; returns its path. */
export declare function postToMailbox(root: string, envelope: MailboxEnvelope): string;
/**
 * Take an undrained letter back. rename is atomic, so exactly one side wins:
 * true = we have it (deliver another way), false = ZCode already took it.
 */
export declare function reclaimMail(path: string): boolean;
/**
 * Is the session in the middle of a turn? ZCode (opencode lineage) writes the
 * assistant message when a turn starts and stamps `time.completed` when it ends —
 * verified live: absent throughout a `sleep 20` turn, present after.
 */
export declare function isSessionBusy(dbFile: string, sessionId: string, now?: number): boolean;
