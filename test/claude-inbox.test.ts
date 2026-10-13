import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDoorbellFrame,
  createClaudeInboxRegistry,
  createDoorbell,
  ringInbox,
  type DoorbellEvent,
  type InboxEntry,
} from '../src/daemon/claude-inbox.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

const LIVE = 'e476487f-5dec-4f2b-93d0-04265cdad6c2';
const OTHER = '7506d124-0000-4000-8000-000000000001';

/** Real-shape registry entry (fields copied from a 2.1.295 desktop session). */
function entry(pid: number, sessionId: string, socket: string): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd: '/w/p',
    version: '2.1.295',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    messagingSocketPath: socket,
    status: 'idle',
  };
}

describe('Claude inbox registry (~/.claude/sessions/<pid>.json)', () => {
  it('keeps only entries whose pid is alive AND whose socket exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anyd-inbox-'));
    const sock = join(dir, 'live.sock');
    writeFileSync(sock, '');
    writeFileSync(join(dir, '100.json'), JSON.stringify(entry(100, LIVE, sock)));
    writeFileSync(join(dir, '200.json'), JSON.stringify(entry(200, OTHER, sock))); // dead pid
    writeFileSync(join(dir, '300.json'), JSON.stringify(entry(100, 'ffffffff-0000-4000-8000-000000000003', join(dir, 'gone.sock'))));
    writeFileSync(join(dir, '400.json'), '{not json');
    writeFileSync(join(dir, '2026-03-28-x-session.tmp'), 'junk');
    writeFileSync(join(dir, '100.abc.key'), 'secret-token');
    const registry = createClaudeInboxRegistry({ dir, isAlive: (pid) => pid === 100 });
    const live = registry();
    expect([...live.keys()]).toEqual([LIVE]);
    expect(live.get(LIVE)).toMatchObject({ pid: 100, socketPath: sock, version: '2.1.295' });
  });

  it('a missing directory is "no live sessions", not an error', () => {
    const registry = createClaudeInboxRegistry({ dir: '/nonexistent/anyd-sessions' });
    expect(registry().size).toBe(0);
  });

  it('caches within the TTL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anyd-inbox-ttl-'));
    const sock = join(dir, 's.sock');
    writeFileSync(sock, '');
    let t = 0;
    const registry = createClaudeInboxRegistry({ dir, isAlive: () => true, ttlMs: 2_000, now: () => t });
    expect(registry().size).toBe(0);
    writeFileSync(join(dir, '1.json'), JSON.stringify(entry(1, LIVE, sock)));
    t = 1_999;
    expect(registry().size).toBe(0); // cached
    t = 2_001;
    expect(registry().size).toBe(1);
  });
});

describe('doorbell frame', () => {
  it('is one JSON line in the inbox wire format, carrying NO message payload', () => {
    const line = buildDoorbellFrame({ messageIds: ['b3a1765a-89c3'], fromLabel: '@codex:frontend' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().includes('\n')).toBe(false);
    const frame = JSON.parse(line) as {
      type: string;
      message: { role: string; content: string };
      msg_id: string;
      priority: string;
    };
    expect(frame.type).toBe('user');
    expect(frame.message.role).toBe('user');
    expect(frame.priority).toBe('next');
    expect(frame.msg_id).toMatch(/^anytoany-/);
    expect(frame.message.content).toContain('[anytoany]');
    expect(frame.message.content).toContain('@codex:frontend');
    expect(frame.message.content).toContain('anyd pull'); // fallback when no hook attached it
  });
});

describe('ringInbox (real unix socket)', () => {
  it('writes exactly the frame line to the session socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anyd-ring-'));
    const path = join(dir, 'inbox.sock');
    const received: string[] = [];
    const server = createServer((c) => c.on('data', (d) => received.push(d.toString())));
    await new Promise<void>((r) => server.listen(path, r));
    const frame = buildDoorbellFrame({ messageIds: ['m1'], fromLabel: '@claude:a' });
    const r = await ringInbox(path, frame);
    await new Promise((r2) => setTimeout(r2, 50));
    server.close();
    expect(r.ok).toBe(true);
    expect(received.join('')).toBe(frame);
  });

  it('reports failure for a socket nobody listens on', async () => {
    const r = await ringInbox('/nonexistent/anyd.sock', 'x\n', 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('doorbell loop', () => {
  const sock = '/tmp/cc-socks/1.sock';
  const inboxes = (): Map<string, InboxEntry> =>
    new Map([[LIVE, { pid: 1, sessionId: LIVE, socketPath: sock, status: 'idle', version: '2.1.295' }]]);

  function setup() {
    const mailbox = createMailbox(createDb(':memory:'));
    const rings: Array<{ path: string; frame: string }> = [];
    const events: DoorbellEvent[] = [];
    const bell = createDoorbell({
      mailbox,
      inboxes,
      ring: async (path, frame) => {
        rings.push({ path, frame });
        return { ok: true };
      },
      onEvent: (e) => events.push(e),
    });
    return { mailbox, rings, events, bell };
  }

  const from = { agent: 'codex', sessionId: 'c0dec0de-0000-4000-8000-000000000001' };

  it('rings a live local Claude session ONCE per batch of pending mail, never again for the same messages', async () => {
    const { mailbox, rings, events, bell } = setup();
    const a = mailbox.send({ from, to: { agent: 'claude', sessionId: LIVE }, text: 'one' });
    const b = mailbox.send({ from, to: { agent: 'claude', sessionId: LIVE }, text: 'two' });
    await bell.tick();
    expect(rings).toEqual([{ path: sock, frame: expect.any(String) }]);
    expect(events[0]).toMatchObject({ kind: 'rung', sessionId: LIVE, messageIds: [a.id, b.id] });
    await bell.tick();
    expect(rings).toHaveLength(1); // already rung — no spam
    // the message itself is untouched: the session's own pull hook takes it
    expect(mailbox.getMessage(a.id)?.status).toBe('pending');

    mailbox.send({ from, to: { agent: 'claude', sessionId: LIVE }, text: 'three' });
    await bell.tick();
    expect(rings).toHaveLength(2); // new mail → ring again
  });

  it('ignores sessions without an inbox, other agents, remote targets and the human', async () => {
    const { mailbox, rings, bell } = setup();
    mailbox.send({ from, to: { agent: 'claude', sessionId: OTHER }, text: 'closed session' });
    mailbox.send({ from, to: { agent: 'codex', sessionId: LIVE }, text: 'not claude' });
    mailbox.send({ from, to: { agent: 'claude', sessionId: LIVE, device: 'mini' }, text: 'remote' });
    mailbox.send({ from, to: { agent: 'user', sessionId: 'cli' }, text: 'human' });
    await bell.tick();
    expect(rings).toHaveLength(0);
  });

  it('a failed ring is reported and NOT retried in a loop — the pull hook remains the fallback', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const events: DoorbellEvent[] = [];
    let calls = 0;
    const bell = createDoorbell({
      mailbox,
      inboxes,
      ring: async () => {
        calls++;
        return { ok: false, error: 'ECONNREFUSED' };
      },
      onEvent: (e) => events.push(e),
    });
    const m = mailbox.send({ from, to: { agent: 'claude', sessionId: LIVE }, text: 'x' });
    await bell.tick();
    await bell.tick();
    expect(calls).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'ring-failed', detail: 'ECONNREFUSED' });
    expect(mailbox.getMessage(m.id)?.status).toBe('pending');
  });
});

describe('doctor: crossSessionInbound readiness (ADR-027)', () => {
  it('reports accept / unset / refuse without failing the default', async () => {
    const { crossSessionInboundCheck } = await import('../src/doctor.js');
    expect(crossSessionInboundCheck({ crossSessionInbound: 'accept' }).ok).toBe(true);
    const unset = crossSessionInboundCheck({});
    expect(unset.ok).toBe(true);
    expect(unset.note).toMatch(/Bypass permissions/);
    expect(crossSessionInboundCheck(null).ok).toBe(true);
    const refuse = crossSessionInboundCheck({ crossSessionInbound: 'refuse' });
    expect(refuse.ok).toBe(false);
  });
});

describe('doorbellUseful — ring only when it can wake someone (ADR-027)', () => {
  it('bypass-by-default without accept: do not ring (frames would only be held)', async () => {
    const { doorbellUseful } = await import('../src/daemon/claude-inbox.js');
    expect(doorbellUseful({ permissions: { defaultMode: 'bypassPermissions' } })).toBe(false);
    expect(doorbellUseful({ permissions: { defaultMode: 'bypassPermissions' }, crossSessionInbound: 'accept' })).toBe(true);
    expect(doorbellUseful({ permissions: { defaultMode: 'default' } })).toBe(true);
    expect(doorbellUseful(null)).toBe(true);
    expect(doorbellUseful({ crossSessionInbound: 'refuse' })).toBe(false);
    expect(doorbellUseful({ crossSessionInbound: 'hold' })).toBe(false);
  });

  it('a disabled gate skips the tick entirely', async () => {
    const { createDoorbell } = await import('../src/daemon/claude-inbox.js');
    const mailbox = createMailbox(createDb(':memory:'));
    let rings = 0;
    const bell = createDoorbell({
      mailbox,
      inboxes: () => new Map([[LIVE, { pid: 1, sessionId: LIVE, socketPath: '/x.sock' }]]),
      ring: async () => {
        rings++;
        return { ok: true };
      },
      enabled: () => false,
    });
    mailbox.send({ from: { agent: 'codex', sessionId: 'c0de' }, to: { agent: 'claude', sessionId: LIVE }, text: 'x' });
    await bell.tick();
    expect(rings).toBe(0);
  });
});

describe('doctor: doorbell OFF under bypass-by-default', () => {
  it('says so and names the opt-in', async () => {
    const { crossSessionInboundCheck } = await import('../src/doctor.js');
    const c = crossSessionInboundCheck({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(c.ok).toBe(true);
    expect(c.note).toMatch(/^OFF/);
    expect(c.note).toContain('"crossSessionInbound": "accept"');
  });
});
