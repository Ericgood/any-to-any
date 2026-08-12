import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { tokenFingerprint } from '../src/cluster/token.js';
import { startConsoleServer, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

const DIRECTORY: SessionInfo[] = [
  { agent: 'claude', sessionId: CLAUDE_A.sessionId, title: 'backend', cwd: '/w/a', lastActiveAt: 1 },
  { agent: 'codex', sessionId: CODEX_B.sessionId, title: 'frontend', cwd: '/w/b', lastActiveAt: 2 },
];

const PORT = 17433;
const base = `http://127.0.0.1:${PORT}`;

describe('console server', () => {
  let mailbox: Mailbox;
  let server: RunningServer;

  beforeAll(() => {
    mailbox = createMailbox(createDb(':memory:'));
    server = startConsoleServer({ mailbox, directory: async () => DIRECTORY, port: PORT, changePollMs: 60_000 });
  });
  afterAll(() => server.close());

  it('serves the web ui at /', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('anytoany console');
  });

  it('GET /api/sessions returns the directory', async () => {
    const { sessions } = (await (await fetch(base + '/api/sessions')).json()) as { sessions: SessionInfo[] };
    expect(sessions).toHaveLength(2);
  });

  it('POST /api/messages creates a conversation and message', async () => {
    const r = await fetch(base + '/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: CLAUDE_A, to: CODEX_B, text: 'from webui test' }),
    });
    expect(r.status).toBe(201);
    const { message } = (await r.json()) as { message: { id: string; conversationId: string; parts: Array<{ via?: string }> } };
    expect(message.parts[0]?.via).toBe('webui');

    const { conversations } = (await (await fetch(base + '/api/conversations')).json()) as {
      conversations: Array<{ id: string; messageCount: number }>;
    };
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messageCount).toBe(1);

    const { messages } = (await (
      await fetch(`${base}/api/conversations/${message.conversationId}/messages`)
    ).json()) as { messages: Array<{ id: string }> };
    expect(messages[0]?.id).toBe(message.id);
  });

  it('POST /api/messages validates the body', async () => {
    const r = await fetch(base + '/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'no refs' }),
    });
    expect(r.status).toBe(400);
  });

  it('retry endpoint rejects non-failed messages with 500 payload', async () => {
    const sent = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    const r = await fetch(`${base}/api/messages/${sent.id}/retry`, { method: 'POST' });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/only failed/i);
  });

  it('unknown routes 404', async () => {
    expect((await fetch(base + '/api/nope')).status).toBe(404);
  });

  it('GET /api/peers reports lan disabled when peering is off', async () => {
    const body = (await (await fetch(base + '/api/peers')).json()) as { lan: boolean; peers: unknown[] };
    expect(body.lan).toBe(false);
    expect(body.peers).toEqual([]);
  });
});

describe('peer endpoints', () => {
  const PEER_PORT = 17434;
  const peerBase = `http://127.0.0.1:${PEER_PORT}`;
  let mailbox: Mailbox;
  let server: RunningServer;

  beforeAll(() => {
    mailbox = createMailbox(createDb(':memory:'));
    server = startConsoleServer({
      mailbox,
      directory: async () => DIRECTORY,
      port: PEER_PORT,
      changePollMs: 60_000,
      peering: {
        selfDevice: 'testbox',
        token: 'secret-token',
        localDirectory: async () => DIRECTORY,
        peers: () => [
          { device: 'mini', host: '10.0.0.2', port: 7433, fp: tokenFingerprint('secret-token'), lastSeenAt: 1 },
          { device: 'stranger', host: '10.0.0.9', port: 7433, fp: 'deadbeef', lastSeenAt: 2 },
        ],
      },
    });
  });
  afterAll(() => server.close());

  it('GET /api/peers lists live peers with pairing state (loopback console route)', async () => {
    const body = (await (await fetch(peerBase + '/api/peers')).json()) as {
      lan: boolean;
      self: { device: string; fp: string } | null;
      peers: Array<{ device: string; paired: boolean }>;
    };
    expect(body.lan).toBe(true);
    expect(body.self?.device).toBe('testbox');
    expect(body.self?.fp).toBe(tokenFingerprint('secret-token'));
    const byDevice = Object.fromEntries(body.peers.map((p) => [p.device, p.paired]));
    expect(byDevice).toEqual({ mini: true, stranger: false });
  });

  it('rejects peer requests without the cluster token', async () => {
    expect((await fetch(peerBase + '/api/peer/sessions')).status).toBe(401);
  });

  it('serves peer info and sessions with a valid token', async () => {
    const headers = { 'x-anytoany-token': 'secret-token' };
    const info = (await (await fetch(peerBase + '/api/peer/info', { headers })).json()) as { device: string };
    expect(info.device).toBe('testbox');
    const { sessions } = (await (await fetch(peerBase + '/api/peer/sessions', { headers })).json()) as {
      sessions: unknown[];
    };
    expect(sessions).toHaveLength(2);
  });

  it('accepts relayed messages into the local mailbox with context preserved', async () => {
    const r = await fetch(peerBase + '/api/peer/messages', {
      method: 'POST',
      headers: { 'x-anytoany-token': 'secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        contextId: 'ctx-from-remote-1',
        from: { agent: 'claude', sessionId: CLAUDE_A.sessionId, device: 'macbook' },
        to: { agent: 'codex', sessionId: CODEX_B.sessionId },
        text: 'relayed hello',
      }),
    });
    expect(r.status).toBe(201);
    const queued = mailbox.inbox({ toSession: CODEX_B.sessionId });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.contextId).toBe('ctx-from-remote-1');
    expect(queued[0]?.from.device).toBe('macbook');
    expect(queued[0]?.to.device).toBeUndefined(); // local target on this side
  });
});
