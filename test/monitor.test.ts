import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMonitor, heartbeat, isMonitored } from '../src/daemon/monitor.js';

describe('monitor heartbeat', () => {
  let home: string;
  let now: number;
  const opts = () => ({ home, now: () => now });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'anytoany-mon-'));
    now = 1_700_000_000_000;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is not monitored before any heartbeat', () => {
    expect(isMonitored('sess-1', opts())).toBe(false);
  });

  it('is monitored right after a heartbeat, and goes stale after freshMs', () => {
    heartbeat('sess-1', opts());
    expect(isMonitored('sess-1', opts())).toBe(true);
    now += 9_000; // still fresh (<10s)
    expect(isMonitored('sess-1', opts())).toBe(true);
    now += 2_000; // now 11s old — stale
    expect(isMonitored('sess-1', opts())).toBe(false);
  });

  it('clearMonitor removes the heartbeat immediately', () => {
    heartbeat('sess-1', opts());
    expect(isMonitored('sess-1', opts())).toBe(true);
    clearMonitor('sess-1', { home });
    expect(isMonitored('sess-1', opts())).toBe(false);
  });

  it('sanitizes session ids with unsafe characters (no path escape)', () => {
    heartbeat('sess_abc/../x', opts());
    expect(isMonitored('sess_abc/../x', opts())).toBe(true);
    expect(isMonitored('other', opts())).toBe(false);
  });

  it('sessions are independent', () => {
    heartbeat('a', opts());
    expect(isMonitored('a', opts())).toBe(true);
    expect(isMonitored('b', opts())).toBe(false);
  });
});
