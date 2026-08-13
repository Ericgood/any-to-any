import { open, readFile, rm } from 'node:fs/promises';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function isStale(lockPath, now, staleMs) {
    let raw;
    try {
        raw = await readFile(lockPath, 'utf8');
    }
    catch (e) {
        // vanished between EEXIST and read — not stale, just retry the create
        if (e.code === 'ENOENT')
            return false;
        throw e;
    }
    try {
        const { ts } = JSON.parse(raw);
        if (typeof ts !== 'number')
            return true; // malformed → stealable
        return now() - ts > staleMs;
    }
    catch {
        return true; // corrupt lock body → stealable rather than wedging forever
    }
}
export async function withFileLock(lockPath, fn, opts = {}) {
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
            }
            finally {
                await fh.close();
            }
            break; // acquired
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
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
    }
    finally {
        await rm(lockPath, { force: true });
    }
}
//# sourceMappingURL=lock.js.map