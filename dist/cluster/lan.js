import { loadOrCreateIdentity } from './identity.js';
import { createPeerApiHandler } from './peer-api.js';
import { fetchPeerSessions, relayToPeer, startPeerRegistry, } from './peers.js';
import { probePeerId, peerRequest, startPeerServer } from './secure-transport.js';
import { createTrustStore } from './trust.js';
const MAX_PENDING = 20;
export async function startLan(opts) {
    const log = opts.log ?? (() => undefined);
    const identity = loadOrCreateIdentity(opts.home);
    const trust = createTrustStore(opts.home);
    const client = { identity, selfName: opts.selfDevice };
    const pendingById = new Map();
    const server = await startPeerServer({
        identity,
        trust,
        port: opts.peerPort,
        ...(opts.bindHost ? { host: opts.bindHost } : {}),
        handle: createPeerApiHandler({
            selfDevice: opts.selfDevice,
            selfId: identity.id,
            mailbox: opts.mailbox,
            ...(opts.collab ? { collab: opts.collab } : {}),
            localDirectory: opts.localDirectory,
            ...(opts.onChange ? { onChange: opts.onChange } : {}),
        }),
        onUntrusted: (contact) => {
            if (!pendingById.has(contact.id)) {
                log(`lan: pairing request from ${contact.claimedName ?? 'unknown'} (${contact.id}) — to accept: anyd pair add ${contact.id}`);
            }
            pendingById.delete(contact.id);
            pendingById.set(contact.id, contact);
            if (pendingById.size > MAX_PENDING)
                pendingById.delete(pendingById.keys().next().value);
        },
    });
    const registry = startPeerRegistry({
        selfDevice: opts.selfDevice,
        selfId: identity.id,
        port: server.port,
        ...(opts.mdns === false ? { mdns: false } : {}),
    });
    for (const spec of opts.staticPeers ?? []) {
        const [host, p] = spec.split(':');
        const port = Number.parseInt(p ?? '', 10);
        if (!host || !Number.isFinite(port))
            continue;
        try {
            const id = await probePeerId({ host, port, identity });
            const trusted = trust.get(id);
            // name it by our trust entry when paired; otherwise ask it (only works once paired)
            let device = trusted?.name ?? host;
            if (trusted) {
                const info = await peerRequest({ host, port, expectedId: id, identity, selfName: opts.selfDevice, method: 'GET', path: '/api/peer/info' });
                device = info.body?.device ?? device;
            }
            registry.addStatic(device, host, port, id);
            log(`lan: static peer @${device} (${host}:${port}) ${trusted ? 'paired' : `NOT paired — anyd pair add ${id}`}`);
        }
        catch (e) {
            log(`warning: static peer ${spec} unreachable at startup: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const pairedPeers = () => registry.list().filter((p) => p.id && trust.get(p.id));
    const findPeer = (device) => {
        const direct = registry.get(device);
        if (direct?.id && trust.get(direct.id))
            return direct;
        // the operator may have named the device differently when pairing
        const named = trust.byName(device);
        return named ? registry.list().find((p) => p.id === named.id) : undefined;
    };
    return {
        selfDevice: opts.selfDevice,
        identity,
        trust,
        registry,
        peerPort: server.port,
        pending: () => [...pendingById.values()].filter((c) => !trust.get(c.id)),
        findPeer,
        async remoteSessions() {
            const results = await Promise.allSettled(pairedPeers().map((p) => fetchPeerSessions(p, client)));
            return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        },
        async relay(device, message) {
            const peer = findPeer(device);
            if (!peer) {
                const seen = registry.get(device);
                return {
                    ok: false,
                    error: seen
                        ? `device "${device}" is on the LAN but not paired — run: anyd pair add ${seen.id}`
                        : `device "${device}" not found on LAN (anyd peers to inspect)`,
                };
            }
            return relayToPeer(peer, message, client);
        },
        stop() {
            registry.stop();
            server.close();
        },
    };
}
//# sourceMappingURL=lan.js.map