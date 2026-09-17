/**
 * External agent registry (ADR-024).
 *
 * Some agents live inside a desktop App and have no headless CLI we can resume
 * into — 闪电说 (`sds`) is the first: its assistant shell runs with a minimal
 * PATH, a workspace-write sandbox that blocks writes to ~/.anytoany, and no
 * self-drive at all. Such an agent instead REGISTERS itself here (over HTTP,
 * via the daemon) so it becomes an addressable first-class target, and PULLS
 * its own mail.
 *
 * Registered sessions are "pull-only": the dispatcher must never headless-
 * resume them — messages stay pending until the agent fetches them. This
 * reuses the same skip mechanism as `monitor.ts` / `session-liveness.ts`
 * (ADR-019 / ADR-023); the storage layout mirrors monitor.ts deliberately.
 */
export interface ExternalSession {
    agent: string;
    sessionId: string;
    title: string;
    cwd: string;
    /** epoch ms of the FIRST registration — preserved across re-registrations. */
    registeredAt: number;
    /** epoch ms of the most recent registration/heartbeat. */
    lastSeenAt: number;
}
export interface RegisterInput {
    agent: string;
    sessionId: string;
    title?: string;
    cwd?: string;
}
interface StoreOpts {
    home?: string;
    now?: () => number;
}
/** Agent names that already mean something else — registering them would make
 *  the directory ambiguous. `user` is the mailbox-as-inbox sink (dispatcher),
 *  the rest have real delivery adapters. */
export declare const RESERVED_AGENT_NAMES: readonly ["user", "claude", "codex", "kimi", "zcode"];
/** Register (or refresh) an external agent session. Upsert: re-registering the
 *  same agent+session keeps `registeredAt` and only moves `lastSeenAt`. */
export declare function register(input: RegisterInput, opts?: StoreOpts): ExternalSession;
/** Forget a registration. Best-effort and idempotent. */
export declare function unregister(agent: string, sessionId: string, opts?: {
    home?: string;
}): void;
/** All registered sessions, most recently seen first. Stale ones are hidden
 *  (their files are kept — re-registering revives the same identity). */
export declare function listRegistered(opts?: StoreOpts & {
    ttlMs?: number;
    includeStale?: boolean;
}): ExternalSession[];
/**
 * Is this session id a registered (pull-only) external session?
 *
 * Used by the dispatcher's claim filter, which only receives a session id — no
 * agent. Deliberately ignores the TTL: a stale external session cannot be
 * headless-resumed either, so skipping it keeps the message pending instead of
 * dead-lettering it.
 */
export declare function isRegisteredSession(sessionId: string, opts?: StoreOpts): boolean;
export {};
