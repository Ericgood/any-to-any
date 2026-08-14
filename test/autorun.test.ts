import { describe, expect, it } from 'vitest';
import type { CollabDoc, CollabTask } from '../src/collab/doc.js';
import type { SessionInfo } from '../src/adapters/types.js';
import { decideTick, productFingerprint, runAutoRunOnce, DEFAULT_AUTORUN_CONFIG } from '../src/daemon/autorun.js';

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

// ── daemon wiring: runAutoRunOnce over in-memory stubs ──
type Sent = { from: { agent: string; sessionId: string }; to: { agent: string; sessionId: string; device?: string }; text: string; via?: string; conversationId?: string };

const SESSIONS: SessionInfo[] = [
  { agent: 'codex', sessionId: 'codexsess-1111', title: 'api service', cwd: '/w/api', lastActiveAt: 2 },
  { agent: 'claude', sessionId: 'claudesess-2222', title: 'web app', cwd: '/w/web', lastActiveAt: 3 },
];

const stubCollab = (docs: CollabDoc[]) => {
  const upserts: Array<{ agent: string; task: CollabTask }> = [];
  return {
    upserts,
    list: () => docs,
    upsertTask: async (conversationId: string, agent: string, t: CollabTask) => {
      upserts.push({ agent, task: t });
      const doc = docs.find((d) => d.conversationId === conversationId)!;
      const i = doc.tasks.findIndex((x) => x.id === t.id);
      if (i >= 0) doc.tasks[i] = t;
      else doc.tasks.push(t);
      return doc;
    },
  };
};

const stubMailbox = () => {
  const sent: Sent[] = [];
  return {
    sent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (input: any) => {
      sent.push(input);
      return { id: 'm' } as any;
    },
    listConversations: () => [] as any,
  };
};

const mkDoc = (taskOver: Partial<CollabTask>, progressEntries: string[] = [], lead = '@claude:web'): CollabDoc => ({
  conversationId: 'conv1',
  lead,
  updated: 'x',
  body: '',
  tasks: [{ id: 't1', owner: '@codex:api', state: 'working', updated: 'x', autoRun: true, ...taskOver }],
  progress: progressEntries.length ? [{ agent: '@codex:api', entries: progressEntries }] : [],
});

const base = () => ({
  directory: async () => SESSIONS,
  isMonitored: () => false,
  selfDevice: 'macbook',
  now: () => T0,
});

describe('runAutoRunOnce (daemon wiring)', () => {
  it('advance: product moved → nudges the worker and records the new fingerprint', async () => {
    const docs = [mkDoc({ productFingerprint: undefined }, ['10:00 wrote /a'])];
    const collab = stubCollab(docs);
    const mailbox = stubMailbox();
    const acted = await runAutoRunOnce({ ...base(), collab, mailbox });
    expect(acted).toBe(1);
    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0]?.to.sessionId).toBe('codexsess-1111'); // owner
    expect(mailbox.sent[0]?.text).toContain('Continue task t1');
    expect(collab.upserts[0]?.task.productFingerprint).toBe('1|10:00 wrote /a');
    expect(collab.upserts[0]?.task.stallCount).toBe(0);
    expect(collab.upserts[0]?.agent).toBe('@claude:web'); // persisted as the lead
  });

  it('retry: no new product within budget → nudges the worker to try differently, bumps stall', async () => {
    const docs = [mkDoc({ productFingerprint: '1|done', stallCount: 0 }, ['done'])];
    const collab = stubCollab(docs);
    const mailbox = stubMailbox();
    await runAutoRunOnce({ ...base(), collab, mailbox });
    expect(mailbox.sent[0]?.to.sessionId).toBe('codexsess-1111');
    expect(mailbox.sent[0]?.text).toContain('DIFFERENT approach');
    expect(collab.upserts[0]?.task.stallCount).toBe(1);
  });

  it('judge: stalled past K → nudges the LEAD (not the worker) and resets the stall budget', async () => {
    const docs = [mkDoc({ productFingerprint: '1|done', stallCount: 2 }, ['done'])];
    const collab = stubCollab(docs);
    const mailbox = stubMailbox();
    await runAutoRunOnce({ ...base(), collab, mailbox });
    expect(mailbox.sent[0]?.to.sessionId).toBe('claudesess-2222'); // the lead
    expect(mailbox.sent[0]?.text).toContain('You are the lead');
    expect(collab.upserts[0]?.task.stallCount).toBe(0);
  });

  it('judge with no reachable lead → escalates straight to the operator, sets needs-decision', async () => {
    const docs = [mkDoc({ productFingerprint: '1|done', stallCount: 2 }, ['done'], '@kimi:ghost')];
    const collab = stubCollab(docs);
    const mailbox = stubMailbox();
    await runAutoRunOnce({ ...base(), collab, mailbox }); // no kimi in directory
    expect(mailbox.sent[0]?.to.agent).toBe('user'); // → @user:cli
    expect(mailbox.sent[0]?.via).toBe('autorun-escalate');
    expect(collab.upserts[0]?.task.state).toBe('needs-decision');
  });

  it('backstop: past the 1h ceiling → escalates to the operator and pauses the task', async () => {
    const startedAt = new Date(T0 - 7200 * 1000).toISOString(); // 2h ago
    const docs = [mkDoc({ startedAt, productFingerprint: '1|done' }, ['done'])];
    const collab = stubCollab(docs);
    const mailbox = stubMailbox();
    await runAutoRunOnce({ ...base(), collab, mailbox });
    expect(mailbox.sent[0]?.to.agent).toBe('user');
    expect(mailbox.sent[0]?.text).toContain('ceiling');
    expect(collab.upserts[0]?.task.state).toBe('needs-decision');
  });

  it('skips a task whose owner is live-monitoring (no double-driving)', async () => {
    const docs = [mkDoc({}, ['10:00 wrote /a'])];
    const mailbox = stubMailbox();
    const acted = await runAutoRunOnce({ ...base(), collab: stubCollab(docs), mailbox, isMonitored: (sid) => sid === 'codexsess-1111' });
    expect(acted).toBe(0);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('skips a cross-device owner (v1 same-machine only)', async () => {
    const remote: SessionInfo[] = [{ agent: 'codex', sessionId: 'codexsess-1111', title: 'api service', cwd: '/w/api', lastActiveAt: 2, device: 'mini' }];
    const docs = [mkDoc({}, ['10:00 wrote /a'])];
    const mailbox = stubMailbox();
    const acted = await runAutoRunOnce({ ...base(), directory: async () => remote, collab: stubCollab(docs), mailbox });
    expect(acted).toBe(0);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('never touches a task that is not marked auto-run', async () => {
    const docs = [mkDoc({ autoRun: false }, ['10:00 wrote /a'])];
    const mailbox = stubMailbox();
    const acted = await runAutoRunOnce({ ...base(), collab: stubCollab(docs), mailbox });
    expect(acted).toBe(0);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('disabled config is a hard off switch', async () => {
    const docs = [mkDoc({}, ['10:00 wrote /a'])];
    const mailbox = stubMailbox();
    const acted = await runAutoRunOnce({ ...base(), collab: stubCollab(docs), mailbox, config: { enabled: false } });
    expect(acted).toBe(0);
    expect(mailbox.sent).toHaveLength(0);
  });
});
