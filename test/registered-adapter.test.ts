import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegisteredAdapter } from '../src/adapters/registered.js';
import { listAllSessions } from '../src/directory/scanner.js';
import { resolveTarget } from '../src/directory/resolve.js';
import { register } from '../src/registry/external.js';
import type { AgentAdapter, SessionInfo } from '../src/adapters/types.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'anytoany-regadapter-'));
});

const claudeStub: AgentAdapter = {
  agent: 'claude',
  listSessions: async (): Promise<SessionInfo[]> => [
    { agent: 'claude', sessionId: 'c-1', title: 'musely studio', cwd: '/w/musely', lastActiveAt: 5_000 },
  ],
};

describe('registered adapter — external agents in the session directory', () => {
  it('maps registrations to SessionInfo, using lastSeenAt as lastActiveAt', async () => {
    register(
      { agent: 'sds', sessionId: 'shandianshuo-abc', title: '闪电说助手', cwd: '/w/sds' },
      { home, now: () => 7_000 },
    );
    const sessions = await createRegisteredAdapter({ home, now: () => 7_000 }).listSessions();

    expect(sessions).toEqual([
      {
        agent: 'sds',
        sessionId: 'shandianshuo-abc',
        title: '闪电说助手',
        cwd: '/w/sds',
        lastActiveAt: 7_000,
      },
    ]);
  });

  it('carries no device — external agents are always on this machine', async () => {
    register({ agent: 'sds', sessionId: 'x' }, { home, now: () => 1 });
    const [s] = await createRegisteredAdapter({ home, now: () => 1 }).listSessions();
    expect(s).not.toHaveProperty('device');
  });

  it('returns an empty directory when nothing is registered', async () => {
    expect(await createRegisteredAdapter({ home }).listSessions()).toEqual([]);
  });

  // It is a plain AgentAdapter on purpose: a registered session must never be
  // headless-delivered to, so it has no `deliver` and must not be put into the
  // dispatcher's Map<string, DeliveryAdapter>.
  it('exposes no deliver() — it is a listing-only adapter (ADR-024)', () => {
    const adapter = createRegisteredAdapter({ home });
    expect('deliver' in adapter).toBe(false);
  });

  it('merges into the directory alongside real adapters, newest first', async () => {
    register({ agent: 'sds', sessionId: 'sds-1', title: '闪电说助手' }, { home, now: () => 9_000 });
    const { sessions, errors } = await listAllSessions([
      claudeStub,
      createRegisteredAdapter({ home, now: () => 9_000 }),
    ]);

    expect(errors).toEqual([]);
    expect(sessions.map((s) => s.agent)).toEqual(['sds', 'claude']);
  });
});

describe('resolving an external agent as a target', () => {
  const directory = async (now = 9_000) =>
    (await listAllSessions([claudeStub, createRegisteredAdapter({ home, now: () => now })])).sessions;

  it('resolves @sds:<fragment> to the registered session', async () => {
    register({ agent: 'sds', sessionId: 'shandianshuo-abc', title: '闪电说助手' }, { home, now: () => 9_000 });
    const r = resolveTarget('@sds:闪电说', await directory());

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.agent).toBe('sds');
      expect(r.session.sessionId).toBe('shandianshuo-abc');
    }
  });

  it('resolves a bare @sds when it is the only session of that agent', async () => {
    register({ agent: 'sds', sessionId: 'shandianshuo-abc', title: '闪电说助手' }, { home, now: () => 9_000 });
    const r = resolveTarget('@sds', await directory());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.sessionId).toBe('shandianshuo-abc');
  });

  it('does not resolve once the registration has gone stale', async () => {
    register({ agent: 'sds', sessionId: 'shandianshuo-abc', title: '闪电说助手' }, { home, now: () => 0 });
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const r = resolveTarget('@sds', await directory(weekMs + 1));
    expect(r.ok).toBe(false);
  });
});
