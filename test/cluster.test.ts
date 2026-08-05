import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { loadOrCreateToken, tokenFingerprint } from '../src/cluster/token.js';
import { resolveTarget } from '../src/directory/resolve.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { routeForMessage } from '../src/cluster/routing.js';

const home = mkdtempSync(join(tmpdir(), 'anytoany-cluster-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('cluster token', () => {
  it('generates once and is stable across loads', () => {
    const t1 = loadOrCreateToken(home);
    const t2 = loadOrCreateToken(home);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect(tokenFingerprint(t1)).toHaveLength(8);
  });
});

describe('device-aware SessionRef storage', () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = createMailbox(createDb(':memory:'));
  });

  it('persists device on from/to and round-trips it', () => {
    const m = mailbox.send({
      from: { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' },
      to: { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002', device: 'mini' },
      text: 'cross device',
    });
    expect(m.to.device).toBe('mini');
    expect(m.from.device).toBeUndefined();
    expect(mailbox.getMessage(m.id)?.to.device).toBe('mini');
  });

  it('same session pair on different devices are different conversations', () => {
    const a = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
    const b = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };
    const m1 = mailbox.send({ from: a, to: b, text: 'local' });
    const m2 = mailbox.send({ from: a, to: { ...b, device: 'mini' }, text: 'remote' });
    expect(m1.conversationId).not.toBe(m2.conversationId);
  });
});

describe('routeForMessage', () => {
  const msg = (device?: string) => ({
    to: { agent: 'codex', sessionId: 'x', ...(device ? { device } : {}) },
  });
  it('routes local when no device or self device', () => {
    expect(routeForMessage(msg(), 'macbook')).toEqual({ kind: 'local' });
    expect(routeForMessage(msg('macbook'), 'macbook')).toEqual({ kind: 'local' });
    expect(routeForMessage(msg('MacBook'), 'macbook')).toEqual({ kind: 'local' });
  });
  it('routes relay for other devices', () => {
    expect(routeForMessage(msg('mini'), 'macbook')).toEqual({ kind: 'relay', device: 'mini' });
  });
});

describe('resolve with device targets', () => {
  const sessions: SessionInfo[] = [
    { agent: 'codex', sessionId: 'aaaa1111-0000-4000-8000-000000000001', title: '本机前端', cwd: '/w/f', lastActiveAt: 2 },
    { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002', title: '远端前端', cwd: '/w/f', lastActiveAt: 5, device: 'mini' },
    { agent: 'claude', sessionId: 'cccc3333-0000-4000-8000-000000000003', title: '远端后端', cwd: '/w/b', lastActiveAt: 4, device: 'mini' },
  ];

  it('no device segment matches local sessions only', () => {
    const r = resolveTarget('@codex:前端', sessions);
    expect(r.ok && r.session.sessionId).toBe('aaaa1111-0000-4000-8000-000000000001');
  });

  it('@device/agent:frag matches sessions on that device', () => {
    const r = resolveTarget('@mini/codex:前端', sessions);
    expect(r.ok && r.session.sessionId).toBe('bbbb2222-0000-4000-8000-000000000002');
  });

  it('device prefix matching is case-insensitive', () => {
    const r = resolveTarget('@Mini/claude', sessions);
    expect(r.ok && r.session.sessionId).toBe('cccc3333-0000-4000-8000-000000000003');
  });

  it('unknown device → not_found with empty candidates', () => {
    const r = resolveTarget('@nas/codex:x', sessions);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});
