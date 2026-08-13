import { open, readFile, rm } from 'node:fs/promises';

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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isStale(lockPath: string, now: () => number, staleMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (e) {
    // vanished between EEXIST and read — not stale, just retry the create
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  try {
    const { ts } = JSON.parse(raw) as { ts?: number };
    if (typeof ts !== 'number') return true; // malformed → stealable
    return now() - ts > staleMs;
  } catch {
    return true; // corrupt lock body → stealable rather than wedging forever
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: LockOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = opts.retryMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: now() }));
      } finally {
        await fh.close();
      }
      break; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await isStale(lockPath, now, staleMs)) {
        await rm(lockPath, { force: true });
        continue; // steal and re-attempt immediately
      }
      if (Date.now() >= deadline) {
        throw new Error(`withFileLock: timed out after ${timeoutMs}ms waiting for ${lockPath}`);
      }
      await delay(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
