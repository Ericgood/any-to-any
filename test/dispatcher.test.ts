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
  { agent: 'claude', sessionId: CLAUDE_A.sessionId, title: '后端重构', cwd: '/w/backend', lastActiveAt: 1 },
  { agent: 'codex', sessionId: CODEX_B.sessionId, title: '前端重构', cwd: '/w/frontend', lastActiveAt: 2 },
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
    expect(adapter.calls[0]?.envelope).toContain('@claude:后端重构'); // sender labelled by title
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
