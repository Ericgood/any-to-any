import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { createCollabStore } from '../src/collab/store.js';
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

  it('collab endpoints return empty/null when no store is configured', async () => {
    const list = (await (await fetch(base + '/api/collab')).json()) as { docs: unknown[] };
    expect(list.docs).toEqual([]);
    const one = (await (await fetch(base + '/api/collab/deadbeef-0000-4000-8000-000000000000')).json()) as { doc: unknown };
    expect(one.doc).toBeNull();
  });
});

describe('console server — collab endpoints (Phase 4)', () => {
  const PORT2 = 17435;
  const base2 = `http://127.0.0.1:${PORT2}`;
  let dir: string;
  let server: RunningServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'anytoany-srv-collab-'));
    const collab = createCollabStore({ dir });
    await collab.ensure({ conversationId: 'cccccccc-0000-4000-8000-000000000001', lead: '@claude:x', body: 'the plan' });
    await collab.upsertTask('cccccccc-0000-4000-8000-000000000001', '@claude:x', { id: 't1', owner: '@codex:y', state: 'working', step: '1/2', updated: '' });
    await collab.appendProgress('cccccccc-0000-4000-8000-000000000001', '@codex:y', 'started');
    server = startConsoleServer({ mailbox: createMailbox(createDb(':memory:')), directory: async () => DIRECTORY, collab, port: PORT2, changePollMs: 60_000 });
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/collab lists doc summaries with open-task counts', async () => {
    const { docs } = (await (await fetch(base2 + '/api/collab')).json()) as {
      docs: Array<{ conversationId: string; lead: string; tasks: number; open: number }>;
    };
    expect(docs).toHaveLength(1);
    expect(docs[0]?.lead).toBe('@claude:x');
    expect(docs[0]?.tasks).toBe(1);
    expect(docs[0]?.open).toBe(1);
  });

  it('GET /api/collab/:id returns the full doc', async () => {
    const { doc } = (await (await fetch(base2 + '/api/collab/cccccccc-0000-4000-8000-000000000001')).json()) as {
      doc: { lead: string; body: string; tasks: unknown[]; progress: Array<{ agent: string; entries: string[] }> };
    };
    expect(doc.lead).toBe('@claude:x');
    expect(doc.body).toBe('the plan');
    expect(doc.progress[0]?.agent).toBe('@codex:y');
    expect(doc.progress[0]?.entries).toEqual(['started']);
  });

  it('GET /api/collab/:id returns {doc:null} for an unknown conversation', async () => {
    const { doc } = (await (await fetch(base2 + '/api/collab/ffffffff-0000-4000-8000-000000000000')).json()) as { doc: unknown };
    expect(doc).toBeNull();
  });

  it('POST advance nudges the task owner with an in-context message', async () => {
    // t1 is owned by @codex:y, which is in the directory as CODEX_B (title "frontend")
    const cdir2 = mkdtempSync(join(tmpdir(), 'anytoany-advance-'));
    const collab = createCollabStore({ dir: cdir2 });
    const CONV = 'dddddddd-0000-4000-8000-000000000001';
    await collab.ensure({ conversationId: CONV, lead: '@claude:backend' });
    await collab.upsertTask(CONV, '@claude:backend', { id: 't1', owner: '@codex:frontend', state: 'working', step: '1/3', updated: '' });
    const mailbox = createMailbox(createDb(':memory:'));
    const PORT3 = 17437;
    const srv = startConsoleServer({ mailbox, directory: async () => DIRECTORY, collab, port: PORT3, changePollMs: 60_000 });
    try {
      const r = await fetch(`http://127.0.0.1:${PORT3}/api/collab/${CONV}/advance`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 't1' }),
      });
      expect(r.status).toBe(201);
      const { message, to } = (await r.json()) as { message: { to: { agent: string }; parts: Array<{ text: string; via?: string }> }; to: { agent: string } };
      expect(to.agent).toBe('codex');
      expect(message.to.agent).toBe('codex');
      expect(message.parts[0]?.via).toBe('advance');
      expect(message.parts[0]?.text).toContain('Continue task t1 (1/3)');
      expect(message.parts[0]?.text).toContain(`anyd collab show ${CONV}`);
    } finally {
      srv.close();
      rmSync(cdir2, { recursive: true, force: true });
    }
  });

  it('POST advance 422s when the task id is unknown', async () => {
    const cdir3 = mkdtempSync(join(tmpdir(), 'anytoany-advance2-'));
    const collab = createCollabStore({ dir: cdir3 });
    const CONV = 'eeeeeeee-0000-4000-8000-000000000001';
    await collab.ensure({ conversationId: CONV, lead: '@claude:backend' });
    const PORT4 = 17438;
    const srv = startConsoleServer({ mailbox: createMailbox(createDb(':memory:')), directory: async () => DIRECTORY, collab, port: PORT4, changePollMs: 60_000 });
    try {
      const r = await fetch(`http://127.0.0.1:${PORT4}/api/collab/${CONV}/advance`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'nope' }),
      });
      expect(r.status).toBe(422);
    } finally {
      srv.close();
      rmSync(cdir3, { recursive: true, force: true });
    }
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

  it('merges a pushed collab doc (POST /api/peer/collab) and rejects a bad token', async () => {
    const cdir = mkdtempSync(join(tmpdir(), 'anytoany-peer-collab-'));
    const collab = createCollabStore({ dir: cdir });
    const PC_PORT = 17436;
    const srv = startConsoleServer({
      mailbox: createMailbox(createDb(':memory:')),
      directory: async () => DIRECTORY,
      collab,
      port: PC_PORT,
      changePollMs: 60_000,
      peering: { selfDevice: 'box', token: 'tok', localDirectory: async () => DIRECTORY },
    });
    try {
      const docMd = [
        '---',
        JSON.stringify({ conversationId: 'sync-0000-4000-8000-000000000001', lead: '@claude:x', updated: '2026-08-13T10:00:00.000Z', tasks: [] }, null, 2),
        '---',
        '',
        'remote plan',
        '',
        '## Progress — @codex:y',
        '',
        '- did the remote thing',
        '',
      ].join('\n');
      // wrong token → 401
      const bad = await fetch(`http://127.0.0.1:${PC_PORT}/api/peer/collab`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: docMd }),
      });
      expect(bad.status).toBe(401);
      // valid token → merged and persisted
      const ok = await fetch(`http://127.0.0.1:${PC_PORT}/api/peer/collab`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-anytoany-token': 'tok' }, body: JSON.stringify({ doc: docMd }),
      });
      expect(ok.status).toBe(200);
      const stored = collab.load('sync-0000-4000-8000-000000000001');
      expect(stored?.body).toBe('remote plan');
      expect(stored?.progress[0]?.entries).toEqual(['did the remote thing']);
    } finally {
      srv.close();
      rmSync(cdir, { recursive: true, force: true });
    }
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
