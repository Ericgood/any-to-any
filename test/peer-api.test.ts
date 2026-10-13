import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../src/cluster/identity.js';
import { createPeerApiHandler } from '../src/cluster/peer-api.js';
import { peerRequest, startPeerServer, type PeerServer } from '../src/cluster/secure-transport.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { createCollabStore } from '../src/collab/store.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };
const DIRECTORY: SessionInfo[] = [
  { agent: 'claude', sessionId: CLAUDE_A.sessionId, title: 'backend', cwd: '/w/a', lastActiveAt: 1 },
  { agent: 'codex', sessionId: CODEX_B.sessionId, title: 'frontend', cwd: '/w/b', lastActiveAt: 2 },
];

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'anyd-peerapi-'));
  homes.push(h);
  return h;
};

// "mini" serves the peer API; "macbook" is the trusted caller.
let mini: DeviceIdentity;
let macbook: DeviceIdentity;
let mailbox: Mailbox;
let server: PeerServer;
let collabDir: string;
let changes = 0;

beforeAll(async () => {
  const miniHome = freshHome();
  mini = loadOrCreateIdentity(miniHome);
  macbook = loadOrCreateIdentity(freshHome());
  createTrustStore(miniHome).add({ id: macbook.id, name: 'macbook' });
  mailbox = createMailbox(createDb(':memory:'));
  collabDir = freshHome();
  server = await startPeerServer({
    identity: mini,
    trust: createTrustStore(miniHome),
    host: '127.0.0.1',
    port: 0,
    handle: createPeerApiHandler({
      selfDevice: 'mini',
      selfId: mini.id,
      mailbox,
      collab: createCollabStore({ dir: collabDir }),
      localDirectory: async () => DIRECTORY,
      onChange: () => changes++,
    }),
  });
});
afterAll(() => {
  server.close();
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  peerRequest({ host: '127.0.0.1', port: server.port, expectedId: mini.id, identity: macbook, selfName: 'macbook', method, path, ...(body ? { body } : {}) });

describe('peer API over mutual TLS (ADR-028)', () => {
  it('info and sessions', async () => {
    expect((await call('GET', '/api/peer/info')).body).toMatchObject({ device: 'mini', id: mini.id });
    const { body } = await call('GET', '/api/peer/sessions');
    expect((body as { sessions: unknown[] }).sessions).toHaveLength(2);
  });

  it('relayed message: from.device is the TRUSTED name, never the self-reported one', async () => {
    const r = await call('POST', '/api/peer/messages', {
      contextId: 'ctx-remote-1',
      from: { agent: 'claude', sessionId: CLAUDE_A.sessionId, device: 'some-other-device' },
      to: { agent: 'codex', sessionId: CODEX_B.sessionId },
      text: 'relayed hello',
    });
    expect(r.status).toBe(201);
    const [queued] = mailbox.inbox({ toSession: CODEX_B.sessionId });
    expect(queued?.contextId).toBe('ctx-remote-1');
    expect(queued?.from.device).toBe('macbook');
    expect(queued?.to.device).toBeUndefined();
    expect(changes).toBeGreaterThan(0);
  });

  it('rejects malformed relays', async () => {
    expect((await call('POST', '/api/peer/messages', { text: 'no refs' })).status).toBe(400);
  });

  it('merges a pushed collab doc', async () => {
    const docMd = [
      '---',
      JSON.stringify({ conversationId: 'sync-0000-4000-8000-000000000001', lead: '@claude:x', updated: '2026-08-13T10:00:00.000Z', tasks: [] }, null, 2),
      '---',
      '',
      'remote plan',
      '',
    ].join('\n');
    expect((await call('POST', '/api/peer/collab', { doc: docMd })).status).toBe(200);
    expect(createCollabStore({ dir: collabDir }).load('sync-0000-4000-8000-000000000001')?.body).toBe('remote plan');
  });

  it('unknown route → 404', async () => {
    expect((await call('GET', '/api/peer/nope')).status).toBe(404);
  });
});
