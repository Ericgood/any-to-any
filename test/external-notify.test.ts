import { describe, expect, it } from 'vitest';
import { startExternalInboxNotifier } from '../src/daemon/external-notify.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import type { ExternalSession } from '../src/registry/external.js';

/**
 * ADR-024: a registered external agent is pull-only, so its mail is never
 * claimed by the dispatcher and never emits a `delivered` event — which is what
 * the normal notifier hangs off (cli.ts). Without this, a reply lands and the
 * operator has no idea. The App itself has no self-drive, so the OS notification
 * IS the wake-up signal.
 */

const SDS: ExternalSession = {
  agent: 'sds',
  sessionId: 'shandianshuo-abc',
  title: '闪电说助手',
  cwd: '/w/sds',
  registeredAt: 0,
  lastSeenAt: 1_000,
};
const CODEX = { agent: 'codex', sessionId: 'codex-1' };

function fakeNotifier() {
  const calls: Array<{ agent: string; title: string; sessionId: string; direction: string }> = [];
  return {
    calls,
    sessionActivity: (agent: string, title: string, sessionId: string, direction: 'received' | 'replied') => {
      calls.push({ agent, title, sessionId, direction });
    },
  };
}

describe('external inbox notifier', () => {
  it('notifies once for a new pending message to a registered session', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const notifier = fakeNotifier();
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [SDS],
      notifier,
      autoStart: false,
    });

    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: '改完了' });
    n.tick();

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]).toMatchObject({ agent: 'sds', title: '闪电说助手', direction: 'received' });

    n.tick(); // same message again — already announced
    expect(notifier.calls).toHaveLength(1);
    n.stop();
  });

  it('reports each announcement through onNotify so the daemon log shows it', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const seen: Array<{ agent: string; id: string }> = [];
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [SDS],
      notifier: fakeNotifier(),
      autoStart: false,
      onNotify: (session, messageId) => seen.push({ agent: session.agent, id: messageId }),
    });

    const m = mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: '来信' });
    n.tick();
    n.tick();

    expect(seen).toEqual([{ agent: 'sds', id: m.id }]);
    n.stop();
  });

  // A daemon restart must not replay every message the agent has not fetched yet.
  it('treats everything already pending at construction time as already seen', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: 'backlog 1' });
    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: 'backlog 2' });

    const notifier = fakeNotifier();
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [SDS],
      notifier,
      autoStart: false,
    });
    n.tick();
    expect(notifier.calls).toHaveLength(0);

    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: 'fresh' });
    n.tick();
    expect(notifier.calls).toHaveLength(1);
    n.stop();
  });

  it('ignores messages addressed to sessions that are not registered', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const notifier = fakeNotifier();
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [SDS],
      notifier,
      autoStart: false,
    });

    mailbox.send({ from: CODEX, to: { agent: 'claude', sessionId: 'some-claude' }, text: 'not yours' });
    n.tick();
    expect(notifier.calls).toHaveLength(0);
    n.stop();
  });

  it('does nothing at all when no external agent is registered', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const notifier = fakeNotifier();
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [],
      notifier,
      autoStart: false,
    });
    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: 'hi' });
    n.tick();
    expect(notifier.calls).toHaveLength(0);
    n.stop();
  });

  it('notices an agent registered after the notifier started', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const notifier = fakeNotifier();
    let registered: ExternalSession[] = [];
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => registered,
      notifier,
      autoStart: false,
    });

    mailbox.send({ from: CODEX, to: { agent: 'sds', sessionId: SDS.sessionId }, text: '来了' });
    n.tick();
    expect(notifier.calls).toHaveLength(0);

    registered = [SDS];
    n.tick();
    expect(notifier.calls).toHaveLength(1);
    n.stop();
  });

  it('survives a mailbox read error without throwing', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const broken = {
      ...mailbox,
      inbox: () => {
        throw new Error('db locked');
      },
    };
    const notifier = fakeNotifier();
    const n = startExternalInboxNotifier({
      mailbox: broken,
      listRegistered: () => [SDS],
      notifier,
      autoStart: false,
    });
    expect(() => n.tick()).not.toThrow();
    n.stop();
  });

  it('stop() clears the timer so the process can exit', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const n = startExternalInboxNotifier({
      mailbox,
      listRegistered: () => [SDS],
      notifier: fakeNotifier(),
      intervalMs: 5,
    });
    expect(() => n.stop()).not.toThrow();
    expect(() => n.stop()).not.toThrow(); // idempotent
  });
});
