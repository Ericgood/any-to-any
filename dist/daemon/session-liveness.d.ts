/** Pure: extract interactively-open Claude session ids from `ps` command output. */
export declare function parseLiveClaudeSessions(psOutput: string): Set<string>;
/**
 * Session ids currently open in an interactive Claude process. Cached briefly so
 * the dispatch hot path can call it cheaply and synchronously. Best-effort: any
 * failure (no `ps`, not permitted, non-macOS/Linux) yields an empty set, so
 * delivery falls back to the normal resume path rather than blocking.
 */
export declare function liveClaudeSessions(now?: () => number): Set<string>;
/** Is this session open in an interactive Claude process right now? */
export declare function isSessionLive(sessionId: string, now?: () => number): boolean;
