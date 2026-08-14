import { describe, expect, it } from 'vitest';
import {
  appendProgress,
  createDoc,
  parse,
  serialize,
  setBody,
  setLead,
  setTasks,
  upsertTask,
  type CollabDoc,
  type CollabTask,
} from '../src/collab/doc.js';

const T0 = '2026-08-13T10:00:00.000Z';
const T1 = '2026-08-13T10:05:00.000Z';
const LEAD = '@claude:web-app';
const WORKER = '@codex:api';

const task = (over: Partial<CollabTask> = {}): CollabTask => ({
  id: 't1',
  owner: WORKER,
  state: 'assigned',
  updated: T0,
  ...over,
});

describe('collab doc — model', () => {
  it('createDoc defaults to empty body/tasks/progress', () => {
    const doc = createDoc({ conversationId: 'conv-1', lead: LEAD, updated: T0 });
    expect(doc).toEqual({
      conversationId: 'conv-1',
      lead: LEAD,
      updated: T0,
      tasks: [],
      body: '',
      progress: [],
    });
  });

  it('createDoc keeps supplied body and tasks', () => {
    const doc = createDoc({
      conversationId: 'conv-1',
      lead: LEAD,
      updated: T0,
      body: '## Goal\nship auth',
      tasks: [task()],
    });
    expect(doc.body).toBe('## Goal\nship auth');
    expect(doc.tasks).toHaveLength(1);
  });
});

describe('collab doc — single-writer enforcement', () => {
  const base = createDoc({ conversationId: 'c', lead: LEAD, updated: T0 });

  it('setBody by the lead updates body and timestamp', () => {
    const next = setBody(base, LEAD, 'new plan', T1);
    expect(next.body).toBe('new plan');
    expect(next.updated).toBe(T1);
    expect(base.body).toBe(''); // original untouched (immutability)
  });

  it('setBody by a non-lead throws', () => {
    expect(() => setBody(base, WORKER, 'sneaky', T1)).toThrow(/only the lead/i);
  });

  it('setTasks by the lead replaces the task list', () => {
    const next = setTasks(base, LEAD, [task(), task({ id: 't2' })], T1);
    expect(next.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('setTasks by a non-lead throws', () => {
    expect(() => setTasks(base, WORKER, [task()], T1)).toThrow(/only the lead/i);
  });

  it('upsertTask replaces a task with the same id, else appends (lead only)', () => {
    const withT1 = upsertTask(base, LEAD, task({ state: 'working', step: '1/3' }), T1);
    const replaced = upsertTask(withT1, LEAD, task({ state: 'done' }), T1);
    expect(replaced.tasks).toHaveLength(1);
    expect(replaced.tasks[0]?.state).toBe('done');
    const added = upsertTask(replaced, LEAD, task({ id: 't2' }), T1);
    expect(added.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('upsertTask by a non-lead throws', () => {
    expect(() => upsertTask(base, WORKER, task(), T1)).toThrow(/only the lead/i);
  });

  it('setLead by the current lead hands off; by anyone else throws', () => {
    const next = setLead(base, LEAD, WORKER, T1);
    expect(next.lead).toBe(WORKER);
    expect(() => setLead(base, WORKER, WORKER, T1)).toThrow(/only the lead/i);
  });
});

describe('collab doc — append-only progress sections', () => {
  const base = createDoc({ conversationId: 'c', lead: LEAD, updated: T0 });

  it('any agent may append to its OWN section, creating it on first use', () => {
    const next = appendProgress(base, WORKER, 'started, plan is 3 steps', T1);
    expect(next.progress).toHaveLength(1);
    expect(next.progress[0]).toEqual({ agent: WORKER, entries: ['started, plan is 3 steps'] });
    expect(next.updated).toBe(T1);
  });

  it('a worker appending needs no lead role', () => {
    // WORKER is not the lead, yet appending to its own section is allowed
    const next = appendProgress(base, WORKER, 'x', T1);
    expect(next.progress[0]?.agent).toBe(WORKER);
  });

  it('appends accumulate under the same agent in order', () => {
    const a = appendProgress(base, WORKER, 'one', T1);
    const b = appendProgress(a, WORKER, 'two', T1);
    expect(b.progress).toHaveLength(1);
    expect(b.progress[0]?.entries).toEqual(['one', 'two']);
  });

  it('different agents get separate sections', () => {
    const a = appendProgress(base, WORKER, 'w', T1);
    const b = appendProgress(a, LEAD, 'l', T1);
    expect(b.progress.map((p) => p.agent)).toEqual([WORKER, LEAD]);
  });

  it('collapses newlines in an entry to keep one bullet per append', () => {
    const next = appendProgress(base, WORKER, 'line one\nline two', T1);
    expect(next.progress[0]?.entries[0]).toBe('line one line two');
  });
});

describe('collab doc — serialize/parse round-trip', () => {
  const rich = (): CollabDoc => {
    let doc = createDoc({
      conversationId: 'conv-abc',
      lead: LEAD,
      updated: T0,
      body: '## Goal\n认证静默刷新\n\n## Division\n- @codex:api → refresh endpoint',
    });
    doc = upsertTask(doc, LEAD, task({ state: 'working', step: '2/4', updated: T1 }), T1);
    doc = upsertTask(doc, LEAD, task({ id: 't2', owner: LEAD, state: 'blocked', note: '等 t1 的 /auth 契约', updated: T1 }), T1);
    doc = appendProgress(doc, WORKER, '10:12Z started; reading authMiddleware', T1);
    doc = appendProgress(doc, WORKER, '10:18Z 2/4 wrote /auth/refresh, returns {token,exp}', T1);
    doc = appendProgress(doc, LEAD, '10:06Z waiting on t1 contract, scaffolding interceptor', T1);
    return doc;
  };

  it('serialize then parse reproduces the document exactly', () => {
    const doc = rich();
    const round = parse(serialize(doc));
    expect(round).toEqual(doc);
  });

  it('round-trips a task carrying self-driving (auto-run) fields (ADR-020)', () => {
    let doc = createDoc({ conversationId: 'c', lead: LEAD, updated: T0, body: 'x' });
    doc = upsertTask(
      doc,
      LEAD,
      task({
        state: 'working',
        step: '2/4',
        autoRun: true,
        startedAt: T1,
        lastTickAt: T1,
        stallCount: 1,
        productFingerprint: 'a1b2c3',
        blockerFingerprint: 'missing-token',
        blockerRepeat: 2,
        updated: T1,
      }),
      T1,
    );
    const round = parse(serialize(doc));
    expect(round).toEqual(doc); // new fields survive the JSON front-matter round-trip
    expect(round.tasks[0]?.autoRun).toBe(true);
    expect(round.tasks[0]?.stallCount).toBe(1);
    expect(round.tasks[0]?.productFingerprint).toBe('a1b2c3');
  });

  it('serialize emits JSON front-matter and Progress headings', () => {
    const text = serialize(rich());
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('"lead": "@claude:web-app"');
    expect(text).toContain('## Progress — @codex:api');
    expect(text).toContain('## Progress — @claude:web-app');
  });

  it('round-trips a body-only doc with no tasks or progress', () => {
    const doc = createDoc({ conversationId: 'c', lead: LEAD, updated: T0, body: 'just a note' });
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it('tolerates trailing whitespace after the document', () => {
    const doc = createDoc({ conversationId: 'c', lead: LEAD, updated: T0, body: 'x' });
    expect(parse(`${serialize(doc)}\n\n  `)).toEqual(doc);
  });
});

describe('collab doc — parse validation', () => {
  it('throws when front-matter is missing', () => {
    expect(() => parse('# just markdown, no front-matter')).toThrow(/front-matter/i);
  });

  it('throws when front-matter JSON is malformed', () => {
    expect(() => parse('---\n{not json}\n---\n')).toThrow(/front-matter|json/i);
  });

  it('throws when a required field is absent', () => {
    expect(() => parse('---\n{"lead":"@x","updated":"t","tasks":[]}\n---\n')).toThrow(/conversationId/i);
  });
});
