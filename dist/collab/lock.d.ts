/**
 * A cooperative advisory file lock for same-machine, single-writer access to a
 * collaboration document. Creation with the `wx` flag (O_EXCL) is atomic, so at
 * most one holder wins; others retry until the lock frees or a stale/corrupt
 * lock is stolen. This guards concurrent same-machine writers (e.g. two agents
 * on one Mac); cross-device serialization is provided separately by the
 * single-writer + relay ordering (spec §8), not by this lock.
 */
export interface LockOptions {
    /** Give up acquiring after this long. Default 5000ms. */
    timeoutMs?: number;
    /** A lock older than this is considered abandoned and stolen. Default 30000ms. */
    staleMs?: number;
    /** Poll interval while waiting. Default 50ms. */
    retryMs?: number;
    /** Clock injection for tests. Default Date.now. */
    now?: () => number;
}
export declare function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, opts?: LockOptions): Promise<T>;
