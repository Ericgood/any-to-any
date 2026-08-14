import { describe, expect, it } from 'vitest';
import type { CollabDoc, CollabTask } from '../src/collab/doc.js';
import { decideTick, productFingerprint, DEFAULT_AUTORUN_CONFIG } from '../src/daemon/autorun.js';

const OWNER = '@codex:api';
const T0 = Date.parse('2026-08-14T10:00:00.000Z');
const cfg = DEFAULT_AUTORUN_CONFIG; // { maxRetries: 2, maxWallClockSec: 3600 }

const doc = (entries: string[]): CollabDoc => ({
  conversationId: 'c',
  lead: '@claude:web',
  updated: 'x',
  tasks: [],
  body: '',
  progress: entries.length ? [{ agent: OWNER, entries }] : [],
});

const task = (over: Partial<CollabTask> = {}): CollabTask => ({
  id: 't1',
  owner: OWNER,
  state: 'working',
  updated: 'x',
  autoRun: true,
  ...over,
});

describe('productFingerprint', () => {
  it("is 'none' when the owner has logged nothing", () => {
    expect(productFingerprint(doc([]), OWNER)).toBe('none');
  });

  it('changes when a new progress entry is appended (real forward motion)', () => {
    const a = productFingerprint(doc(['10:00 wrote /a']), OWNER);
    const b = productFingerprint(doc(['10:00 wrote /a', '10:05 wrote /b']), OWNER);
    expect(a).not.toBe(b);
  });

  it('is stable when nothing changed', () => {
    expect(productFingerprint(doc(['x']), OWNER)).toBe(productFingerprint(doc(['x']), OWNER));
  });
});

describe('decideTick (ADR-020 — product, not time)', () => {
  it('skips a task that is not auto-run', () => {
    expect(decideTick(task({ autoRun: false }), 'fp', { now: T0, config: cfg }).kind).toBe('skip');
  });

  it('skips a terminal/paused state (done/blocked/needs-decision/failed)', () => {
    for (const state of ['done', 'blocked', 'needs-decision', 'failed'] as const) {
      expect(decideTick(task({ state }), 'fp', { now: T0, config: cfg }).kind).toBe('skip');
    }
  });

  it('advances when the product fingerprint moved since last tick', () => {
    expect(decideTick(task({ productFingerprint: 'old' }), 'new', { now: T0, config: cfg })).toEqual({
      kind: 'advance',
      fingerprint: 'new',
    });
  });

  it('self-retries (no lead) while within the K budget when there is no new product', () => {
    expect(decideTick(task({ productFingerprint: 'same', stallCount: 0 }), 'same', { now: T0, config: cfg })).toEqual({
      kind: 'retry',
      attempt: 1,
    });
    expect(decideTick(task({ productFingerprint: 'same', stallCount: 1 }), 'same', { now: T0, config: cfg })).toEqual({
      kind: 'retry',
      attempt: 2,
    });
  });

  it('asks the lead to judge once stalls exceed K (default 2 → judge on the 3rd)', () => {
    expect(decideTick(task({ productFingerprint: 'same', stallCount: 2 }), 'same', { now: T0, config: cfg })).toEqual({
      kind: 'judge',
      stalls: 3,
    });
  });

  it('hits the wall-clock backstop just past the ceiling', () => {
    const startedAt = new Date(T0).toISOString();
    const r = decideTick(task({ startedAt, productFingerprint: 'same' }), 'same', {
      now: T0 + 3601 * 1000,
      config: cfg,
    });
    expect(r.kind).toBe('backstop');
  });

  it('does NOT backstop just under the ceiling', () => {
    const startedAt = new Date(T0).toISOString();
    const r = decideTick(task({ startedAt, productFingerprint: 'same', stallCount: 0 }), 'same', {
      now: T0 + 3599 * 1000,
      config: cfg,
    });
    expect(r.kind).toBe('retry');
  });

  it('backstop takes precedence over an otherwise-advancing tick', () => {
    const startedAt = new Date(T0).toISOString();
    expect(
      decideTick(task({ startedAt, productFingerprint: 'old' }), 'new', { now: T0 + 7200 * 1000, config: cfg }).kind,
    ).toBe('backstop');
  });
});
