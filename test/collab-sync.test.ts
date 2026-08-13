import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { serialize } from '../src/collab/doc.js';
import { createCollabStore, type CollabStore } from '../src/collab/store.js';
import { pushCollabDoc } from '../src/cluster/peers.js';
import { startConsoleServer, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

// Two daemons on one host (device A :17440, device B :17441), same cluster token,
// proving cross-device collab sync over real HTTP: push A→B, edit on B, push B→A,
// and confirm both converge to the same plan + union of progress.
const TOKEN = 'cluster-secret';
const DIRECTORY: SessionInfo[] = [];
const CONV = 'aaaaaaaa-0000-4000-8000-00000000abcd';
const LEAD = '@claude:web-app';
const WORKER = '@codex:api';

describe('collab cross-device sync (M3)', () => {
  let dirA: string, dirB: string;
  let storeA: CollabStore, storeB: CollabStore;
  let srvA: RunningServer, srvB: RunningServer;
  const peerA = { device: 'A', host: '127.0.0.1', port: 17440 };
  const peerB = { device: 'B', host: '127.0.0.1', port: 17441 };

  beforeAll(() => {
    dirA = mkdtempSync(join(tmpdir(), 'anytoany-syncA-'));
    dirB = mkdtempSync(join(tmpdir(), 'anytoany-syncB-'));
    storeA = createCollabStore({ dir: dirA });
    storeB = createCollabStore({ dir: dirB });
    const mk = (collab: CollabStore, port: number, device: string) =>
      startConsoleServer({
        mailbox: createMailbox(createDb(':memory:')),
        directory: async () => DIRECTORY,
        collab,
        port,
        changePollMs: 60_000,
        peering: { selfDevice: device, token: TOKEN, localDirectory: async () => DIRECTORY },
      });
    srvA = mk(storeA, 17440, 'A');
    srvB = mk(storeB, 17441, 'B');
  });
  afterAll(() => {
    srvA.close();
    srvB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('pushes a doc A→B, then converges after B edits and pushes back', async () => {
    // A (the lead) sets up the plan and logs its own progress
    await storeA.ensure({ conversationId: CONV, lead: LEAD, body: 'goal: wire /auth refresh' });
    await storeA.upsertTask(CONV, LEAD, { id: 't1', owner: WORKER, state: 'working', step: '1/3', updated: '' });
    await storeA.appendProgress(CONV, LEAD, 'scaffolded interceptor');

    // A pushes to B — B has never seen this doc, stores it verbatim
    const push1 = await pushCollabDoc(peerB, serialize(storeA.load(CONV)!), TOKEN);
    expect(push1.ok).toBe(true);
    expect(storeB.load(CONV)?.body).toBe('goal: wire /auth refresh');
    expect(storeB.load(CONV)?.tasks[0]?.state).toBe('working');

    // B (the worker) appends its own progress to the SAME conversation id
    await storeB.appendProgress(CONV, WORKER, 'wrote /auth/refresh, returns {token,exp}');

    // B pushes back to A — A merges: keeps the plan, gains B's progress
    const push2 = await pushCollabDoc(peerA, serialize(storeB.load(CONV)!), TOKEN);
    expect(push2.ok).toBe(true);

    const a = storeA.load(CONV)!;
    const byAgent = Object.fromEntries(a.progress.map((p) => [p.agent, p.entries]));
    expect(byAgent[LEAD]).toEqual(['scaffolded interceptor']);
    expect(byAgent[WORKER]).toEqual(['wrote /auth/refresh, returns {token,exp}']);

    // one more round each way → both sides identical (convergent, idempotent)
    await pushCollabDoc(peerB, serialize(storeA.load(CONV)!), TOKEN);
    await pushCollabDoc(peerA, serialize(storeB.load(CONV)!), TOKEN);
    const finalA = storeA.load(CONV)!;
    const finalB = storeB.load(CONV)!;
    expect(finalA.body).toBe(finalB.body);
    expect(finalA.lead).toBe(finalB.lead);
    expect(finalA.tasks).toEqual(finalB.tasks);
    const norm = (s: CollabStore) => Object.fromEntries(s.load(CONV)!.progress.map((p) => [p.agent, p.entries]));
    expect(norm(storeA)).toEqual(norm(storeB));
  });

  it('rejects a push carrying the wrong cluster token', async () => {
    const r = await pushCollabDoc(peerB, serialize(storeA.load(CONV) ?? (await storeA.ensure({ conversationId: CONV, lead: LEAD }))), 'wrong-token');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });
});
