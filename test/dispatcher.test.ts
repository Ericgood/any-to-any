import { beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryAdapter, DeliveryResult, SessionInfo } from '../src/adapters/types.js';
import { dispatchOnce, startDispatcher } from '../src/daemon/dispatcher.js';
import { REPLY_MARKER } from '../src/envelope.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

const KIMI_C = { agent: 'kimi', sessionId: 'cccc3333-0000-4000-8000-000000000003' };

const DIRECTORY: SessionInfo[] = [
  { agent: 'claude', sessionId: CLAUDE_A.sessionId, title: 'backend refactor', cwd: '/w/backend', lastActiveAt: 1 },
  { agent: 'codex', sessionId: CODEX_B.sessionId, title: 'frontend refactor', cwd: '/w/frontend', lastActiveAt: 2 },
  { agent: 'kimi', sessionId: KIMI_C.sessionId, title: 'k session', cwd: '/w/k', lastActiveAt: 3 },
];

function fakeAdapter(agent: string, impl: (session: SessionInfo, envelope: string) => DeliveryResult): DeliveryAdapter & { calls: Array<{ session: SessionInfo; envelope: string }> } {
  const calls: Array<{ session: SessionInfo; envelope: string }> = [];
  return {
    agent,
    calls,
    listSessions: async () => [],
    deliver: async (session, envelope) => {
      calls.push({ session, envelope });
      return impl(session, envelope);
    },
  };
}

describe('dispatchOnce', () => {
  let mailbox: Mailbox;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    mailbox = createMailbox(createDb(':memory:'), { now: () => nowMs });
  });

  const run = (adapters: DeliveryAdapter[]) =>
    dispatchOnce({
      mailbox,
      adapters: new Map(adapters.map((a) => [a.agent, a])),
      directory: async () => DIRECTORY,
    });

  it('returns false on empty mailbox', async () => {
    expect(await run([fakeAdapter('codex', () => ({ ok: true, output: '' }))])).toBe(false);
  });

  it('delivers to the right adapter with an envelope and marks delivered', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: 'done' }));
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'run the tests' });
    expect(await run([adapter])).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.session.sessionId).toBe(CODEX_B.sessionId);
    expect(adapter.calls[0]?.envelope).toContain('run the tests');
    expect(adapter.calls[0]?.envelope).toContain('@claude:backend refactor'); // sender labelled by title
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
  });

  it('auto-files a reply message when stdout carries the reply marker', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: `work...\n${REPLY_MARKER} 12 tests green` }));
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'run tests' });
    await run([adapter]);
    const replies = mailbox.inbox({ toSession: CLAUDE_A.sessionId });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.parts[0]?.text).toBe('12 tests green');
    expect(replies[0]?.contextId).toBe(m.contextId);
  });

  it('does not file a reply without the marker', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: 'silent work' }));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    await run([adapter]);
    expect(mailbox.inbox({ toSession: CLAUDE_A.sessionId })).toHaveLength(0);
  });

  it('marks failed with the adapter error', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: false, error: 'exec exploded' }));
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    await run([adapter]);
    const after = mailbox.getMessage(m.id);
    expect(after?.status).toBe('failed');
    expect(after?.lastError).toBe('exec exploded');
  });

  it('fails when target session is not in the directory', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: '' }));
    const m = mailbox.send({ from: CLAUDE_A, to: { agent: 'codex', sessionId: 'gone-0000-4000-8000-000000000000' }, text: 'x' });
    await run([adapter]);
    expect(mailbox.getMessage(m.id)?.status).toBe('failed');
    expect(mailbox.getMessage(m.id)?.lastError).toMatch(/not found/i);
    expect(adapter.calls).toHaveLength(0);
  });

  it('fails when no adapter exists for the target agent', async () => {
    const m = mailbox.send({ from: CLAUDE_A, to: KIMI_C, text: 'x' });
    await run([fakeAdapter('codex', () => ({ ok: true, output: '' }))]);
    expect(mailbox.getMessage(m.id)?.status).toBe('failed');
    expect(mailbox.getMessage(m.id)?.lastError).toMatch(/no adapter/i);
  });

  it('fails when the directory supplier itself throws', async () => {
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    await dispatchOnce({
      mailbox,
      adapters: new Map(),
      directory: async () => {
        throw new Error('scan blew up');
      },
    });
    expect(mailbox.getMessage(m.id)?.lastError).toMatch(/scan blew up/);
  });

  it('fails when the adapter deliver call throws (not just rejects politely)', async () => {
    const throwing: DeliveryAdapter = {
      agent: 'codex',
      listSessions: async () => [],
      deliver: async () => {
        throw new Error('spawn ENOENT');
      },
    };
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    await run([throwing]);
    expect(mailbox.getMessage(m.id)?.lastError).toMatch(/ENOENT/);
  });

  it('relays messages targeting another device instead of local delivery', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: '' }));
    const relayed: Array<{ device: string; id: string }> = [];
    const m = mailbox.send({ from: CLAUDE_A, to: { ...CODEX_B, device: 'mini' }, text: 'go remote' });
    await dispatchOnce({
      mailbox,
      adapters: new Map([[adapter.agent, adapter]]),
      directory: async () => DIRECTORY,
      selfDevice: 'macbook',
      relay: async (device, msg) => {
        relayed.push({ device, id: msg.id });
        return { ok: true };
      },
    });
    expect(relayed).toEqual([{ device: 'mini', id: m.id }]);
    expect(adapter.calls).toHaveLength(0); // local adapter untouched
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
  });

  it('fails relay-targeted messages when relay is not configured', async () => {
    const m = mailbox.send({ from: CLAUDE_A, to: { ...CODEX_B, device: 'mini' }, text: 'x' });
    await run([fakeAdapter('codex', () => ({ ok: true, output: '' }))]);
    expect(mailbox.getMessage(m.id)?.status).toBe('failed');
    expect(mailbox.getMessage(m.id)?.lastError).toMatch(/relay/i);
  });

  it('startDispatcher drains the queue then stops cleanly', async () => {
    const adapter = fakeAdapter('codex', () => ({ ok: true, output: 'no marker' }));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'one' });
    const running = startDispatcher(
      { mailbox, adapters: new Map([[adapter.agent, adapter]]), directory: async () => DIRECTORY },
      { intervalMs: 10 },
    );
    await new Promise((r) => setTimeout(r, 150));
    running.stop();
    expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
    expect(mailbox.inbox({})).toHaveLength(0);
  });
});

describe('virtual user recipient', () => {
  it('replies addressed to the human land as delivered — the mailbox is the inbox', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({
      from: { agent: 'zcode', sessionId: 'sess_x' },
      to: { agent: 'user', sessionId: 'cli' },
      text: 'reply for the human',
    });
    const events: string[] = [];
    const ok = await dispatchOnce({
      mailbox,
      adapters: new Map(),
      directory: async () => [],
      onEvent: (e) => events.push(e.kind),
    });
    expect(ok).toBe(true);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(events).toEqual(['delivered']);
  });

  it('a reply to the user on ANOTHER device relays home, not local-inbox (cross-machine bug)', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    // On mini: kimi replies to the human who lives on macbook. Must relay back.
    const m = mailbox.send({
      from: { agent: 'kimi', sessionId: 'session_x' },
      to: { agent: 'user', sessionId: 'cli', device: 'macbook' },
      text: '/Users/alex/projects/api-service',
    });
    const relayed: Array<{ device: string; id: string }> = [];
    const events: string[] = [];
    const ok = await dispatchOnce({
      mailbox,
      adapters: new Map(),
      directory: async () => [],
      selfDevice: 'mini',
      relay: async (device, msg) => {
        relayed.push({ device, id: msg.id });
        return { ok: true };
      },
      onEvent: (e) => events.push(e.kind),
    });
    expect(ok).toBe(true);
    expect(relayed).toEqual([{ device: 'macbook', id: m.id }]); // relayed home
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
  });

  it('a reply to the LOCAL user (self device) still lands in the local inbox', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({
      from: { agent: 'kimi', sessionId: 'session_x' },
      to: { agent: 'user', sessionId: 'cli', device: 'macbook' },
      text: 'local reply',
    });
    const events: Array<{ kind: string; detail?: string }> = [];
    const ok = await dispatchOnce({
      mailbox,
      adapters: new Map(),
      directory: async () => [],
      selfDevice: 'macbook', // the user IS on this machine
      relay: async () => ({ ok: false, error: 'should not be called' }),
      onEvent: (e) => events.push({ kind: e.kind, detail: e.detail }),
    });
    expect(ok).toBe(true);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(events).toEqual([{ kind: 'delivered', detail: 'user-inbox' }]);
  });
});

describe('anti-pingpong suppression', () => {
  const mkOpts = (mailbox: Mailbox, output: string) => ({
    mailbox,
    adapters: new Map<string, DeliveryAdapter>([
      ['codex', fakeAdapter('codex', () => ({ ok: true, output }))],
    ]),
    directory: async () => DIRECTORY,
  });

  it('a BLOCKED reply to a BLOCKED message is suppressed — two waiting agents must not ack forever', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'BLOCKED waiting for user authorization' });
    const events: string[] = [];
    const details: string[] = [];
    await dispatchOnce({
      ...mkOpts(mailbox, `did some thinking\n${REPLY_MARKER} BLOCKED same here, waiting for the user`),
      onEvent: (e) => {
        events.push(e.kind);
        if (e.detail) details.push(e.detail);
      },
    });
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(events).toEqual(['delivered', 'reply-rejected']);
    expect(details.join(' ')).toContain('pingpong');
    expect(mailbox.inbox({ all: true })).toHaveLength(1); // no reply filed
  });

  it('a NOOP reply is never filed back', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'DONE deployed, no further action' });
    const events: string[] = [];
    await dispatchOnce({
      ...mkOpts(mailbox, `${REPLY_MARKER} NOOP`),
      onEvent: (e) => events.push(e.kind),
    });
    expect(events).toEqual(['delivered', 'reply-rejected']);
    expect(mailbox.inbox({ all: true })).toHaveLength(1);
  });

  it('suppresses NOOP even when the agent appends prose after it (real over-explaining case)', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'DONE deployed' });
    const events: string[] = [];
    await dispatchOnce({
      ...mkOpts(mailbox, `${REPLY_MARKER} NOOP\n\n---\n\nready here, waiting for Codex to trigger the next task. Standing by, not acting.`),
      onEvent: (e) => events.push(e.kind),
    });
    expect(events).toEqual(['delivered', 'reply-rejected']);
    expect(mailbox.inbox({ all: true })).toHaveLength(1); // trailing prose does not defeat suppression
  });

  it('does not mistake NOOP-prefixed real words for a noop verdict', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'status?' });
    const events: string[] = [];
    await dispatchOnce({
      ...mkOpts(mailbox, `${REPLY_MARKER} NOOPETH is a made-up word, here is real content`),
      onEvent: (e) => events.push(e.kind),
    });
    expect(events).toEqual(['delivered', 'reply-filed']);
    expect(mailbox.inbox({ all: true })).toHaveLength(2);
  });

  it('a substantive (non-BLOCKED) reply to a BLOCKED message still flows', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'BLOCKED waiting for user authorization' });
    const events: string[] = [];
    await dispatchOnce({
      ...mkOpts(mailbox, `${REPLY_MARKER} switch to plan B: skip waiting for auth, use mock data to get the flow working`),
      onEvent: (e) => events.push(e.kind),
    });
    expect(events).toEqual(['delivered', 'reply-filed']);
    expect(mailbox.inbox({ all: true })).toHaveLength(2);
  });
});

describe('non-retryable delivery failures', () => {
  it('a result with retry:false goes straight to dead (no wasteful re-run of a turn that already ran)', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'heavy task' });
    const adapter = fakeAdapter('codex', () => ({ ok: false, error: 'codex exec resume timed out after 300s', retry: false }));
    await dispatchOnce({ mailbox, adapters: new Map([['codex', adapter]]), directory: async () => DIRECTORY });
    expect(mailbox.getMessage(m.id)?.status).toBe('dead'); // not 'failed' (which would retry)
  });
})
