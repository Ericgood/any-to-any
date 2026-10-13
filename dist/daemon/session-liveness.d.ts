/** Pure: extract interactively-open Claude session ids from `ps` command output. */
export declare function parseLiveClaudeSessions(psOutput: string): Set<string>;
/**
 * Session ids currently open in an interactive Claude process. Cached briefly so
 * the dispatch hot path can call it cheaply and synchronously. Best-effort: any
 * failure (no `ps`, not permitted, non-macOS/Linux) yields an empty set, so
 * delivery falls back to the normal resume path rather than blocking.
 */
export declare function liveClaudeSessions(now?: () => number): Set<string>;
/** Pure: thread ids whose writer lock appears as an open file in `lsof -F n` output. */
export declare function parseCodexLockHolders(lsofOutput: string): Set<string>;
export interface CodexLivenessOptions {
    /** `<CODEX_HOME>/thread-writer-locks` */
    lockDir?: string;
    /** Returns `lsof -F n` output for the given lock files. */
    holders?: (paths: string[]) => string;
    ttlMs?: number;
}
/** Build a cached probe for Codex threads that currently have a live writer. */
export declare function createCodexLiveness(options?: CodexLivenessOptions): (now?: () => number) => Set<string>;
/** Codex thread ids currently held by a writer (typically Codex Desktop's app-server). */
export declare const liveCodexThreads: (now?: () => number) => Set<string>;
/**
 * Is this local session being run by a live process that surfaces its own mail, so
 * the dispatcher must NOT headless-resume into it? Claude only: the inbox registry
 * (ADR-027 — the only signal that sees desktop-App sessions, whose command line has
 * no `--resume=`) plus the `ps` scan (ADR-023). Live Codex threads are NOT skipped
 * any more: the codex adapter queues into Codex Desktop instead (ADR-027).
 */
export declare function isSessionLive(sessionId: string, now?: () => number): boolean;
