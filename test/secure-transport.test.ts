import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity, type DeviceIdentity } from '../src/cluster/identity.js';
import { peerRequest, probePeerId, startPeerServer, type PeerServer } from '../src/cluster/secure-transport.js';
import { createTrustStore, type TrustStore } from '../src/cluster/trust.js';

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'anyd-tls-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('trust store (~/.anytoany/trusted-devices.json)', () => {
  it('adds owner-tier devices, finds by id or name, removes by either', () => {
    const store = createTrustStore(freshHome());
    const mini = loadOrCreateIdentity(freshHome()).id;
    store.add({ id: mini, name: 'mini' });
    expect(store.get(mini)).toMatchObject({ id: mini, name: 'mini', tier: 'owner' });
    expect(store.byName('MINI')?.id).toBe(mini);
    expect(store.list()).toHaveLength(1);
    expect(store.remove('mini')).toBe(true);
    expect(store.get(mini)).toBeUndefined();
    expect(store.remove('nope')).toBe(false);
  });

  it('re-adding an id updates its name instead of duplicating', () => {
    const store = createTrustStore(freshHome());
    const id = loadOrCreateIdentity(freshHome()).id;
    store.add({ id, name: 'device-x' });
    store.add({ id, name: 'mini' });
    expect(store.list()).toEqual([expect.objectContaining({ id, name: 'mini' })]);
  });

  it('picks up edits made by another process (anyd pair add while the daemon runs)', () => {
    const home = freshHome();
    const daemonView = createTrustStore(home);
    expect(daemonView.list()).toHaveLength(0);
    const id = loadOrCreateIdentity(freshHome()).id;
    createTrustStore(home).add({ id, name: 'mini' }); // the CLI process
    expect(daemonView.get(id)?.name).toBe('mini');
  });

  it('a corrupt file is "nobody trusted", never a crash', () => {
    const home = freshHome();
    const store = createTrustStore(home);
    store.add({ id: loadOrCreateIdentity(freshHome()).id, name: 'x' });
    writeFileSync(join(home, '.anytoany', 'trusted-devices.json'), '{oops');
    expect(createTrustStore(home).list()).toEqual([]);
  });
});

/** Two devices on one host, each with its own identity and trust list. */
function device(): { identity: DeviceIdentity; trust: TrustStore } {
  const home = freshHome();
  return { identity: loadOrCreateIdentity(home), trust: createTrustStore(home) };
}

describe('mutual TLS between devices (real sockets)', () => {
  const servers: PeerServer[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  async function serve(owner: ReturnType<typeof device>, onUntrusted?: (id: string, name: string) => void) {
    const seen: string[] = [];
    const server = await startPeerServer({
      identity: owner.identity,
      trust: owner.trust,
      host: '127.0.0.1',
      port: 0,
      onUntrusted: (p) => onUntrusted?.(p.id, p.claimedName ?? ''),
      handle: async (req, res, peer) => {
        seen.push(`${req.method} ${req.url} from ${peer.name}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: peer.name }));
      },
    });
    servers.push(server);
    return { server, seen };
  }

  it('paired both ways → the request goes through and the server knows who called', async () => {
    const macbook = device();
    const mini = device();
    macbook.trust.add({ id: mini.identity.id, name: 'mini' });
    mini.trust.add({ id: macbook.identity.id, name: 'macbook' });
    const { server, seen } = await serve(mini);
    const r = await peerRequest({
      host: '127.0.0.1',
      port: server.port,
      expectedId: mini.identity.id,
      identity: macbook.identity,
      selfName: 'macbook',
      method: 'GET',
      path: '/api/peer/info',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hello: 'macbook' });
    expect(seen).toEqual(['GET /api/peer/info from macbook']);
  });

  it('an unpaired client is refused (403) and recorded as a pairing request — handler never runs', async () => {
    const mini = device();
    const stranger = device();
    const requests: Array<[string, string]> = [];
    const { server, seen } = await serve(mini, (id, name) => requests.push([id, name]));
    const r = await peerRequest({
      host: '127.0.0.1',
      port: server.port,
      expectedId: mini.identity.id,
      identity: stranger.identity,
      selfName: 'laptop',
      method: 'POST',
      path: '/api/peer/messages',
      body: { text: 'run rm -rf /' },
    });
    expect(r.status).toBe(403);
    expect(seen).toEqual([]);
    expect(requests).toEqual([[stranger.identity.id, 'laptop']]);
  });

  it('a server that is not who we expected is dropped BEFORE any byte of the request is sent', async () => {
    const macbook = device();
    const realMini = device();
    const impostor = device(); // same mDNS name, different key
    impostor.trust.add({ id: macbook.identity.id, name: 'macbook' }); // even if it would accept us
    const { server, seen } = await serve(impostor);
    await expect(
      peerRequest({
        host: '127.0.0.1',
        port: server.port,
        expectedId: realMini.identity.id,
        identity: macbook.identity,
        selfName: 'macbook',
        method: 'POST',
        path: '/api/peer/messages',
        body: { text: 'secret plan' },
      }),
    ).rejects.toThrow(/identity mismatch/i);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });

  it('a client without any certificate gets 401', async () => {
    const mini = device();
    const { server, seen } = await serve(mini);
    const { request } = await import('node:https');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/api/peer/info', rejectUnauthorized: false },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('probePeerId reports which device answers at an address (for static peers / pairing)', async () => {
    const mini = device();
    const { server } = await serve(mini);
    expect(await probePeerId({ host: '127.0.0.1', port: server.port, identity: device().identity })).toBe(mini.identity.id);
  });
});
