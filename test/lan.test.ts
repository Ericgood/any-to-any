import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { startLan, type Lan } from '../src/cluster/lan.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

// Two daemons' LAN layers on one host — the end-to-end shape of ADR-028:
// identities, explicit pairing, encrypted relay, trusted-name stamping.
const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'anyd-lan-'));
  homes.push(h);
  return h;
};
const lans: Lan[] = [];
afterAll(() => {
  lans.forEach((l) => l.stop());
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

const CODEX = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };
const CLAUDE = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };

async function boot(name: string, sessions: SessionInfo[] = []) {
  const home = freshHome();
  const mailbox: Mailbox = createMailbox(createDb(':memory:'));
  const logs: string[] = [];
  const lan = await startLan({
    selfDevice: name,
    peerPort: 0,
    bindHost: '127.0.0.1',
    mailbox,
    localDirectory: async () => sessions,
    home,
    mdns: false,
    log: (l) => logs.push(l),
  });
  lans.push(lan);
  return { lan, mailbox, home, logs };
}

describe('LAN layer: pair, then talk over mutual TLS (ADR-028)', () => {
  it('unpaired: relay refused with the exact pairing command, and the other side records a pairing request', async () => {
    const macbook = await boot('macbook');
    const mini = await boot('mini');
    macbook.lan.registry.addStatic('mini', '127.0.0.1', mini.lan.peerPort, mini.lan.identity.id);
    const message = macbook.mailbox.send({ from: CLAUDE, to: { ...CODEX, device: 'mini' }, text: 'hi' });

    const r1 = await macbook.lan.relay('mini', message);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain(`anyd pair add ${mini.lan.identity.id}`);

    // macbook trusts mini, mini doesn't trust macbook yet → mini refuses, records the request
    createTrustStore(macbook.home).add({ id: mini.lan.identity.id, name: 'mini' });
    const r2 = await macbook.lan.relay('mini', message);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain(`anyd pair add ${macbook.lan.identity.id}`);
    expect(mini.lan.pending()).toEqual([expect.objectContaining({ id: macbook.lan.identity.id, claimedName: 'macbook' })]);
    expect(mini.mailbox.inbox({ toSession: CODEX.sessionId })).toHaveLength(0);
  });

  it('paired both ways: relay lands, stamped with the trusted name; directory aggregates', async () => {
    const macbook = await boot('macbook');
    const mini = await boot('mini', [{ agent: 'codex', sessionId: CODEX.sessionId, title: 'frontend', cwd: '/w', lastActiveAt: 1 }]);
    createTrustStore(macbook.home).add({ id: mini.lan.identity.id, name: 'mini' });
    // pairing applies to the running daemon without a restart (mtime-based reload)
    createTrustStore(mini.home).add({ id: macbook.lan.identity.id, name: 'macbook' });
    macbook.lan.registry.addStatic('mini', '127.0.0.1', mini.lan.peerPort, mini.lan.identity.id);

    const message = macbook.mailbox.send({ from: CLAUDE, to: { ...CODEX, device: 'mini' }, text: 'over TLS' });
    expect(await macbook.lan.relay('mini', message)).toEqual({ ok: true });
    const [landed] = mini.mailbox.inbox({ toSession: CODEX.sessionId });
    expect(landed?.parts[0]?.text).toBe('over TLS');
    expect(landed?.from.device).toBe('macbook');
    expect(mini.lan.pending()).toEqual([]);

    const remote = await macbook.lan.remoteSessions();
    expect(remote).toEqual([expect.objectContaining({ sessionId: CODEX.sessionId, device: 'mini' })]);
  });

  it('a device advertising a paired name but a different key is never used', async () => {
    const macbook = await boot('macbook');
    const realMini = await boot('mini');
    const impostor = await boot('mini');
    createTrustStore(macbook.home).add({ id: realMini.lan.identity.id, name: 'mini' });
    // mDNS is spoofable: the impostor shows up as "mini" with ITS id
    macbook.lan.registry.addStatic('mini', '127.0.0.1', impostor.lan.peerPort, impostor.lan.identity.id);
    expect(macbook.lan.findPeer('mini')).toBeUndefined();
    // ...and even if it lied about the id, TLS pinning drops it before sending
    macbook.lan.registry.addStatic('mini', '127.0.0.1', impostor.lan.peerPort, realMini.lan.identity.id);
    const message = macbook.mailbox.send({ from: CLAUDE, to: { ...CODEX, device: 'mini' }, text: 'secret' });
    const r = await macbook.lan.relay('mini', message);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/identity mismatch/);
    expect(impostor.mailbox.inbox({ toSession: CODEX.sessionId })).toHaveLength(0);
  });
});
