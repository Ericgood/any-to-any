import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollabStore, type CollabStore } from '../src/collab/store.js';

const LEAD = '@claude:web-app';
const WORKER = '@codex:api';
const CONV = 'conv-abc-123';

describe('collab store', () => {
  let dir: string;
  let store: CollabStore;
  let nowMs: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anytoany-collab-'));
    nowMs = 1_700_000_000_000;
    store = createCollabStore({ dir, now: () => nowMs });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ensure creates the doc file and load reads it back', async () => {
    const doc = await store.ensure({ conversationId: CONV, lead: LEAD, body: 'goal: ship auth' });
    expect(doc.lead).toBe(LEAD);
    expect(doc.body).toBe('goal: ship auth');
    expect(existsSync(store.path(CONV))).toBe(true);
    expect(store.exists(CONV)).toBe(true);
    expect(store.load(CONV)?.body).toBe('goal: ship auth');
  });

  it('ensure is idempotent and never clobbers an existing lead/body', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD, body: 'first' });
    const again = await store.ensure({ conversationId: CONV, lead: WORKER, body: 'second' });
    expect(again.lead).toBe(LEAD);
    expect(again.body).toBe('first');
  });

  it('load returns null for an absent conversation', () => {
    expect(store.load('nope')).toBeNull();
    expect(store.exists('nope')).toBe(false);
  });

  it('setBody by the lead persists; by a non-lead throws and leaves the file intact', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD, body: 'orig' });
    nowMs += 1000;
    await store.setBody(CONV, LEAD, 'updated plan');
    expect(store.load(CONV)?.body).toBe('updated plan');

    await expect(store.setBody(CONV, WORKER, 'sneaky')).rejects.toThrow(/only the lead/i);
    expect(store.load(CONV)?.body).toBe('updated plan'); // unchanged
  });

  it('appendProgress persists and accumulates across separate calls', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD });
    await store.appendProgress(CONV, WORKER, 'started');
    await store.appendProgress(CONV, WORKER, '2/4 wrote endpoint');
    const doc = store.load(CONV)!;
    expect(doc.progress).toHaveLength(1);
    expect(doc.progress[0]?.entries).toEqual(['started', '2/4 wrote endpoint']);
  });

  it('upsertTask and setLead persist; lead handoff transfers write rights', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD });
    await store.upsertTask(CONV, LEAD, { id: 't1', owner: WORKER, state: 'working', step: '1/2', updated: '' });
    expect(store.load(CONV)?.tasks[0]?.state).toBe('working');

    await store.setLead(CONV, LEAD, WORKER);
    expect(store.load(CONV)?.lead).toBe(WORKER);
    // old lead can no longer write; new lead can
    await expect(store.setBody(CONV, LEAD, 'x')).rejects.toThrow(/only the lead/i);
    await store.setBody(CONV, WORKER, 'handed over');
    expect(store.load(CONV)?.body).toBe('handed over');
  });

  it('mutating a non-existent doc throws (must ensure/init first)', async () => {
    await expect(store.appendProgress('ghost', WORKER, 'x')).rejects.toThrow(/no collab doc/i);
  });

  it('load surfaces corruption instead of hiding it as null', async () => {
    writeFileSync(store.path(CONV), 'garbage without front-matter');
    expect(() => store.load(CONV)).toThrow(/front-matter/i);
  });

  it('rejects an unsafe conversationId (path traversal)', async () => {
    await expect(store.ensure({ conversationId: '../escape', lead: LEAD })).rejects.toThrow(/invalid conversation/i);
    expect(() => store.load('../escape')).toThrow(/invalid conversation/i);
  });

  it('serializes concurrent appends from two agents — no lost update', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD });
    await Promise.all([
      store.appendProgress(CONV, WORKER, 'from worker'),
      store.appendProgress(CONV, LEAD, 'from lead'),
    ]);
    const doc = store.load(CONV)!;
    const agents = doc.progress.map((p) => p.agent).sort();
    expect(agents).toEqual([LEAD, WORKER].sort());
    // no stray lock file left behind
    expect(existsSync(`${store.path(CONV)}.lock`)).toBe(false);
  });

  it('list returns all docs newest-updated first and ignores lock/tmp files', async () => {
    nowMs = 1000;
    await store.ensure({ conversationId: 'older', lead: LEAD });
    nowMs = 2000;
    await store.ensure({ conversationId: 'newer', lead: LEAD });
    // a stray lock/tmp sibling must not appear as a doc
    writeFileSync(join(dir, 'newer.md.lock'), '{}');
    const ids = store.list().map((d) => d.conversationId);
    expect(ids).toEqual(['newer', 'older']);
  });

  it('list is empty before the collab dir exists', () => {
    const fresh = createCollabStore({ dir: join(dir, 'does-not-exist-yet'), now: () => nowMs });
    expect(fresh.list()).toEqual([]);
  });

  it('writes JSON front-matter to disk (human- and machine-readable)', async () => {
    await store.ensure({ conversationId: CONV, lead: LEAD, body: 'hi' });
    const raw = readFileSync(store.path(CONV), 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('"conversationId": "conv-abc-123"');
  });
});
