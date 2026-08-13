import { describe, expect, it } from 'vitest';
import { mergeDoc } from '../src/collab/merge.js';
import { appendProgress, createDoc, upsertTask, type CollabDoc } from '../src/collab/doc.js';

const T = (m: number) => `2026-08-13T10:${String(m).padStart(2, '0')}:00.000Z`;
const LEAD = '@claude:web-app';
const CODEX = '@codex:api';
const CONV = 'conv-1';

const doc = (over: Partial<CollabDoc> = {}): CollabDoc => ({
  ...createDoc({ conversationId: CONV, lead: LEAD, updated: T(0) }),
  ...over,
});

describe('mergeDoc — cross-device convergence', () => {
  it('refuses to merge documents of different conversations', () => {
    const a = doc();
    const b = doc({ conversationId: 'other' });
    expect(() => mergeDoc(a, b)).toThrow(/different conversation/i);
  });

  it('takes the lead-owned region (lead/tasks/body) from the newer side', () => {
    const older = doc({ body: 'old plan', updated: T(1) });
    const newer = doc({ body: 'new plan', updated: T(5), lead: CODEX });
    expect(mergeDoc(older, newer).body).toBe('new plan');
    expect(mergeDoc(older, newer).lead).toBe(CODEX);
    // symmetric: order of arguments does not change the outcome
    expect(mergeDoc(newer, older).body).toBe('new plan');
  });

  it('unions progress sections, keeping the fuller one per agent', () => {
    let local = doc({ updated: T(2) });
    local = appendProgress(local, CODEX, 'a1', T(2));
    local = appendProgress(local, CODEX, 'a2', T(3)); // local has 2 codex entries
    let incoming = doc({ updated: T(1) });
    incoming = appendProgress(incoming, CODEX, 'a1', T(1)); // 1 codex entry
    incoming = appendProgress(incoming, LEAD, 'l1', T(1)); // and a lead entry local lacks

    const merged = mergeDoc(local, incoming);
    const byAgent = Object.fromEntries(merged.progress.map((p) => [p.agent, p.entries]));
    expect(byAgent[CODEX]).toEqual(['a1', 'a2']); // fuller local section kept
    expect(byAgent[LEAD]).toEqual(['l1']); // incoming-only section added
  });

  it('updated becomes the max of both sides', () => {
    expect(mergeDoc(doc({ updated: T(2) }), doc({ updated: T(7) })).updated).toBe(T(7));
    expect(mergeDoc(doc({ updated: T(9) }), doc({ updated: T(3) })).updated).toBe(T(9));
  });

  it('is idempotent — merging the same incoming twice is stable', () => {
    let local = appendProgress(doc({ updated: T(2) }), CODEX, 'x', T(2));
    let incoming = appendProgress(doc({ updated: T(3), body: 'p' }), LEAD, 'y', T(3));
    const once = mergeDoc(local, incoming);
    const twice = mergeDoc(once, incoming);
    expect(twice).toEqual(once);
  });

  it('converges: two machines that exchange docs reach identical state', () => {
    // macbook: lead sets plan + claude progress
    let mac = upsertTask(doc({ updated: T(4) }), LEAD, { id: 't1', owner: CODEX, state: 'working', step: '1/3', updated: T(4) }, T(4));
    mac = appendProgress(mac, LEAD, 'scaffolded interceptor', T(4));
    // mini: codex progress, older lead region
    let mini = doc({ updated: T(2) });
    mini = appendProgress(mini, CODEX, 'wrote /auth/refresh', T(2));

    const macAfter = mergeDoc(mac, mini); // macbook merges mini's doc
    const miniAfter = mergeDoc(mini, mac); // mini merges macbook's doc

    // same lead-region (macbook's newer), same union of progress
    expect(macAfter.body).toBe(miniAfter.body);
    expect(macAfter.lead).toBe(miniAfter.lead);
    expect(macAfter.tasks).toEqual(miniAfter.tasks);
    expect(macAfter.updated).toBe(miniAfter.updated);
    const norm = (d: CollabDoc) => Object.fromEntries(d.progress.map((p) => [p.agent, p.entries]));
    expect(norm(macAfter)).toEqual(norm(miniAfter));
  });

  it('breaks ties deterministically so equal-timestamp edits still converge', () => {
    const a = doc({ body: 'aaa', updated: T(5) });
    const b = doc({ body: 'bbb', updated: T(5) }); // same timestamp, different body
    // both directions pick the same winner
    expect(mergeDoc(a, b).body).toBe(mergeDoc(b, a).body);
  });
});
