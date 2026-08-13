import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/collab/lock.js';

describe('withFileLock', () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anytoany-lock-'));
    lock = join(dir, 'x.md.lock');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the critical section, returns its value, and releases the lock', async () => {
    const result = await withFileLock(lock, () => 42);
    expect(result).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it('serializes overlapping critical sections (no interleave)', async () => {
    const trace: string[] = [];
    const section = (tag: string) => async () => {
      trace.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, 20));
      trace.push(`${tag}-end`);
    };
    await Promise.all([
      withFileLock(lock, section('a'), { retryMs: 2 }),
      withFileLock(lock, section('b'), { retryMs: 2 }),
    ]);
    // whichever ran first, its start/end must be adjacent — never a-start,b-start,…
    expect(trace).toHaveLength(4);
    expect(trace[1]).toBe(`${trace[0]!.split('-')[0]}-end`);
    expect(trace[3]).toBe(`${trace[2]!.split('-')[0]}-end`);
  });

  it('releases the lock even when the critical section throws', async () => {
    await expect(
      withFileLock(lock, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(lock)).toBe(false);
  });

  it('times out when the lock is held by a live holder', async () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await expect(withFileLock(lock, () => 1, { timeoutMs: 60, retryMs: 10 })).rejects.toThrow(/timed out/i);
  });

  it('steals a stale lock and proceeds', async () => {
    writeFileSync(lock, JSON.stringify({ pid: 999999, ts: Date.now() - 120_000 }));
    const result = await withFileLock(lock, () => 'ok', { staleMs: 30_000 });
    expect(result).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });

  it('steals a corrupt lock file rather than wedging forever', async () => {
    writeFileSync(lock, 'not json at all');
    const result = await withFileLock(lock, () => 'recovered', { timeoutMs: 200, retryMs: 10 });
    expect(result).toBe('recovered');
  });
});
