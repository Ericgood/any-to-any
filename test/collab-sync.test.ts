import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { serialize } from '../src/collab/doc.js';
import { createCollabStore, type CollabStore } from '../src/collab/store.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../src/cluster/identity.js';
import { createPeerApiHandler } from '../src/cluster/peer-api.js';
import { pushCollabDoc, type PeerClient } from '../src/cluster/peers.js';
import { startPeerServer, type PeerServer } from '../src/cluster/secure-transport.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

// Two devices on one host, each with its own identity, paired both ways (ADR-028),
// proving cross-device collab sync over real mutual TLS: push A→B, edit on B, push
// B→A, and confirm both converge to the same plan + union of progress.
const DIRECTORY: SessionInfo[] = [];
const CONV = 'aaaaaaaa-0000-4000-8000-00000000abcd';
const LEAD = '@claude:web-app';
const WORKER = '@codex:api';

describe('collab cross-device sync (M3)', () => {
  const dirs: string[] = [];
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  let storeA: CollabStore, storeB: CollabStore;
  let srvA: PeerServer, srvB: PeerServer;
  let idA: DeviceIdentity, idB: DeviceIdentity;
  let clientA: PeerClient, clientB: PeerClient;
  let peerA: { device: string; host: string; port: number; id: string };
  let peerB: { device: string; host: string; port: number; id: string };

  beforeAll(async () => {
    const homeA = tmp('anytoany-syncA-home-');
    const homeB = tmp('anytoany-syncB-home-');
    idA = loadOrCreateIdentity(homeA);
    idB = loadOrCreateIdentity(homeB);
    createTrustStore(homeA).add({ id: idB.id, name: 'B' });
    createTrustStore(homeB).add({ id: idA.id, name: 'A' });
    storeA = createCollabStore({ dir: tmp('anytoany-syncA-') });
    storeB = createCollabStore({ dir: tmp('anytoany-syncB-') });
    const mk = (identity: DeviceIdentity, home: string, collab: CollabStore, device: string) =>
      startPeerServer({
        identity,
        trust: createTrustStore(home),
        host: '127.0.0.1',
        port: 0,
        handle: createPeerApiHandler({
          selfDevice: device,
          mailbox: createMailbox(createDb(':memory:')),
          collab,
          localDirectory: async () => DIRECTORY,
        }),
      });
    srvA = await mk(idA, homeA, storeA, 'A');
    srvB = await mk(idB, homeB, storeB, 'B');
    peerA = { device: 'A', host: '127.0.0.1', port: srvA.port, id: idA.id };
    peerB = { device: 'B', host: '127.0.0.1', port: srvB.port, id: idB.id };
    clientA = { identity: idA, selfName: 'A' };
    clientB = { identity: idB, selfName: 'B' };
  });
  afterAll(() => {
    srvA.close();
    srvB.close();
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  it('pushes a doc A→B, then converges after B edits and pushes back', async () => {
    // A (the lead) sets up the plan and logs its own progress
    await storeA.ensure({ conversationId: CONV, lead: LEAD, body: 'goal: wire /auth refresh' });
    await storeA.upsertTask(CONV, LEAD, { id: 't1', owner: WORKER, state: 'working', step: '1/3', updated: '' });
    await storeA.appendProgress(CONV, LEAD, 'scaffolded interceptor');

    // A pushes to B — B has never seen this doc, stores it verbatim
    const push1 = await pushCollabDoc(peerB, serialize(storeA.load(CONV)!), clientA);
    expect(push1.ok).toBe(true);
    expect(storeB.load(CONV)?.body).toBe('goal: wire /auth refresh');
    expect(storeB.load(CONV)?.tasks[0]?.state).toBe('working');

    // B (the worker) appends its own progress to the SAME conversation id
    await storeB.appendProgress(CONV, WORKER, 'wrote /auth/refresh, returns {token,exp}');

    // B pushes back to A — A merges: keeps the plan, gains B's progress
    const push2 = await pushCollabDoc(peerA, serialize(storeB.load(CONV)!), clientB);
    expect(push2.ok).toBe(true);

    const a = storeA.load(CONV)!;
    const byAgent = Object.fromEntries(a.progress.map((p) => [p.agent, p.entries]));
    expect(byAgent[LEAD]).toEqual(['scaffolded interceptor']);
    expect(byAgent[WORKER]).toEqual(['wrote /auth/refresh, returns {token,exp}']);

    // one more round each way → both sides identical (convergent, idempotent)
    await pushCollabDoc(peerB, serialize(storeA.load(CONV)!), clientA);
    await pushCollabDoc(peerA, serialize(storeB.load(CONV)!), clientB);
    const finalA = storeA.load(CONV)!;
    const finalB = storeB.load(CONV)!;
    expect(finalA.body).toBe(finalB.body);
    expect(finalA.lead).toBe(finalB.lead);
    expect(finalA.tasks).toEqual(finalB.tasks);
    const norm = (s: CollabStore) => Object.fromEntries(s.load(CONV)!.progress.map((p) => [p.agent, p.entries]));
    expect(norm(storeA)).toEqual(norm(storeB));
  });

  it('rejects a push from a device B has not paired with — and says how to pair', async () => {
    const stranger = loadOrCreateIdentity(tmp('anytoany-sync-stranger-'));
    const doc = storeA.load(CONV) ?? (await storeA.ensure({ conversationId: CONV, lead: LEAD }));
    const r = await pushCollabDoc(peerB, serialize(doc), { identity: stranger, selfName: 'stranger' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`anyd pair add ${stranger.id}`);
  });
});
