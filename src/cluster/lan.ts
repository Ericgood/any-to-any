import type { SessionInfo } from '../adapters/types.js';
import type { CollabStore } from '../collab/store.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import { loadOrCreateIdentity, type DeviceIdentity } from './identity.js';
import { createPeerApiHandler } from './peer-api.js';
import {
  fetchPeerSessions,
  relayToPeer,
  startPeerRegistry,
  type Peer,
  type PeerClient,
  type PeerRegistry,
} from './peers.js';
import { probePeerId, peerRequest, startPeerServer, type PeerServer, type UntrustedContact } from './secure-transport.js';
import { createTrustStore, type TrustStore } from './trust.js';

/**
 * The daemon's LAN layer (ADR-002 discovery + ADR-028 identity/encryption):
 * our identity, the trust list, mDNS discovery, the mutual-TLS peer server, and
 * the client side (directory aggregation, relay). Only paired peers are used.
 */

export interface LanOptions {
  selfDevice: string;
  /** Mutual-TLS peer port (console port + 1 by default). */
  peerPort: number;
  mailbox: Mailbox;
  collab?: CollabStore;
  localDirectory: () => Promise<SessionInfo[]>;
  onChange?: () => void;
  /** host:port of peers to add without mDNS (debugging, mDNS-hostile networks). */
  staticPeers?: string[];
  /** Isolated home for tests; defaults to ANYTOANY_HOME / ~. */
  home?: string;
  /** Disable mDNS (tests). */
  mdns?: boolean;
  bindHost?: string;
  log?: (line: string) => void;
}

export interface Lan {
  selfDevice: string;
  identity: DeviceIdentity;
  trust: TrustStore;
  registry: PeerRegistry;
  peerPort: number;
  /** Unpaired devices that contacted us, newest last (pairing requests). */
  pending(): UntrustedContact[];
  /** A paired peer by device name (trusted name or mDNS name). */
  findPeer(device: string): Peer | undefined;
  remoteSessions(): Promise<SessionInfo[]>;
  relay(device: string, message: Message): Promise<{ ok: boolean; error?: string }>;
  stop(): void;
}

const MAX_PENDING = 20;

export async function startLan(opts: LanOptions): Promise<Lan> {
  const log = opts.log ?? (() => undefined);
  const identity = loadOrCreateIdentity(opts.home);
  const trust = createTrustStore(opts.home);
  const client: PeerClient = { identity, selfName: opts.selfDevice };

  const pendingById = new Map<string, UntrustedContact>();
  const server: PeerServer = await startPeerServer({
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
      if (pendingById.size > MAX_PENDING) pendingById.delete(pendingById.keys().next().value as string);
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
    if (!host || !Number.isFinite(port)) continue;
    try {
      const id = await probePeerId({ host, port, identity });
      const trusted = trust.get(id);
      // name it by our trust entry when paired; otherwise ask it (only works once paired)
      let device = trusted?.name ?? host;
      if (trusted) {
        const info = await peerRequest({ host, port, expectedId: id, identity, selfName: opts.selfDevice, method: 'GET', path: '/api/peer/info' });
        device = (info.body as { device?: string } | null)?.device ?? device;
      }
      registry.addStatic(device, host, port, id);
      log(`lan: static peer @${device} (${host}:${port}) ${trusted ? 'paired' : `NOT paired — anyd pair add ${id}`}`);
    } catch (e) {
      log(`warning: static peer ${spec} unreachable at startup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const pairedPeers = (): Peer[] => registry.list().filter((p) => p.id && trust.get(p.id));

  const findPeer = (device: string): Peer | undefined => {
    const direct = registry.get(device);
    if (direct?.id && trust.get(direct.id)) return direct;
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
