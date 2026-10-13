import { Bonjour, type Service } from 'bonjour-service';
import type { SessionInfo } from '../adapters/types.js';
import type { Message } from '../mailbox/mailbox.js';
import type { DeviceIdentity } from './identity.js';
import { peerRequest } from './secure-transport.js';

export interface Peer {
  device: string;
  host: string;
  /** The peer's mutual-TLS port (ADR-028). */
  port: number;
  /** Device ID from mDNS TXT — public, and only usable by whoever holds its key. */
  id: string;
  lastSeenAt: number;
}

/** What we present when calling a peer: our identity and our device name. */
export interface PeerClient {
  identity: DeviceIdentity;
  selfName: string;
}

export interface PeerRegistry {
  list(): Peer[];
  get(device: string): Peer | undefined;
  /** Manually add a peer (debugging / no-mDNS environments). */
  addStatic(device: string, host: string, port: number, id: string): void;
  stop(): void;
}

const SERVICE_TYPE = 'anytoany';

/**
 * Pick the address a LAN peer is actually reachable on. mDNS advertises every
 * interface, including proxy TUN fakes (198.18.0.0/15) and link-local junk —
 * prefer RFC1918 private ranges, never return known-unroutable ranges.
 */
export function pickLanAddress(addresses: string[]): string | undefined {
  const ipv4 = addresses.filter((a) => a.includes('.'));
  const unroutable = (a: string) =>
    a.startsWith('127.') ||
    a.startsWith('169.254.') ||
    a.startsWith('198.18.') ||
    a.startsWith('198.19.');
  const isPrivate = (a: string) =>
    a.startsWith('192.168.') ||
    a.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return ipv4.find((a) => isPrivate(a) && !unroutable(a)) ?? ipv4.find((a) => !unroutable(a));
}

export interface DiscoveryOptions {
  selfDevice: string;
  /** Our mutual-TLS peer port, announced over mDNS. */
  port: number;
  /** Our public device ID, announced so others can pair with us (ADR-028). */
  selfId: string;
  /** Disable mDNS (tests / --peer only mode). */
  mdns?: boolean;
  /** Browse without announcing — for passive CLI scans that have no real port. */
  publish?: boolean;
}

/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry {
  const peers = new Map<string, Peer>();
  let publisher: Bonjour | null = null;
  let finder: Bonjour | null = null;
  let requery: NodeJS.Timeout | null = null;

  if (opts.mdns !== false) {
    if (opts.publish !== false) {
      publisher = new Bonjour();
      publisher.publish({
        name: `anytoany-${opts.selfDevice}`,
        type: SERVICE_TYPE,
        port: opts.port,
        txt: { device: opts.selfDevice, id: opts.selfId },
        // A same-name record on the network can only be our own stale ghost
        // (a crashed daemon that never sent its mDNS goodbye). Probing would
        // throw an uncatchable name-conflict — announce and reclaim instead.
        probe: false,
      });
    }
    // Separate instance for browsing: sharing a socket with the publisher
    // starves the browser's own queries — it then only ever overhears
    // responses triggered by other hosts (verified on macOS).
    finder = new Bonjour();
    const browser = finder.find({ type: SERVICE_TYPE });
    const upsert = (service: Service): void => {
      const txt = (service.txt ?? {}) as { device?: string; id?: string };
      const device = txt.device;
      if (!device || device.toLowerCase() === opts.selfDevice.toLowerCase()) return;
      const host = pickLanAddress(service.addresses ?? []) ?? service.host;
      if (!host) return;
      peers.set(device.toLowerCase(), {
        device,
        host,
        port: service.port,
        id: txt.id ?? '',
        lastSeenAt: Date.now(),
      });
      // Same endpoint under another name = the device was renamed (or a ghost
      // advert from its previous daemon) — drop the stale alias so the
      // directory doesn't aggregate one machine twice.
      for (const [key, p] of peers) {
        if (key !== device.toLowerCase() && p.host === host && p.port === service.port) peers.delete(key);
      }
    };
    browser.on('up', upsert);
    browser.on('down', (service: Service) => {
      const txt = (service.txt ?? {}) as { device?: string };
      if (txt.device) peers.delete(txt.device.toLowerCase());
    });
    // The browser's initial query can be silently lost (socket races at
    // startup); it never re-asks on its own and would then only overhear
    // responses triggered by other hosts. Re-query periodically (verified fix).
    requery = setInterval(() => browser.update(), 30_000);
    requery.unref?.();
  }

  return {
    list: () => [...peers.values()],
    get: (device) => peers.get(device.toLowerCase()),
    addStatic(device, host, port, id) {
      peers.set(device.toLowerCase(), { device, host, port, id, lastSeenAt: Date.now() });
    },
    stop() {
      if (requery) clearInterval(requery);
      publisher?.destroy();
      finder?.destroy();
    },
  };
}

type PeerAddress = Pick<Peer, 'device' | 'host' | 'port' | 'id'>;

/** One call to a paired peer over pinned mutual TLS (ADR-028). */
async function callPeer(
  peer: PeerAddress,
  client: PeerClient,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!peer.id) throw new Error(`peer ${peer.device} did not announce a device ID (older anytoany?) — upgrade it`);
  return peerRequest({
    host: peer.host,
    port: peer.port,
    expectedId: peer.id,
    identity: client.identity,
    selfName: client.selfName,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
}

function httpError(peer: PeerAddress, client: PeerClient, status: number, body: unknown): string {
  if (status === 403) {
    return `peer ${peer.device}: not paired — on @${peer.device} run: anyd pair add ${client.identity.id}`;
  }
  const detail = (body as { error?: string } | null)?.error ?? '';
  return `peer ${peer.device}: HTTP ${status} ${detail}`.trim();
}

const unreachable = (peer: PeerAddress, e: unknown): string =>
  `peer ${peer.device} unreachable: ${e instanceof Error ? e.message : String(e)}`;

/** Pull a peer's local session directory, stamping each entry with its device. */
export async function fetchPeerSessions(peer: Peer, client: PeerClient): Promise<SessionInfo[]> {
  const r = await callPeer(peer, client, 'GET', '/api/peer/sessions');
  if (r.status !== 200) throw new Error(httpError(peer, client, r.status, r.body));
  const { sessions } = r.body as { sessions: SessionInfo[] };
  return sessions.map((s) => ({ ...s, device: peer.device }));
}

/**
 * Push our copy of a collaboration doc (serialized markdown) to a peer daemon,
 * which merges it convergently (Phase 4 / M3).
 */
export async function pushCollabDoc(
  peer: PeerAddress,
  docSerialized: string,
  client: PeerClient,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await callPeer(peer, client, 'POST', '/api/peer/collab', { doc: docSerialized });
    return r.status === 200 ? { ok: true } : { ok: false, error: httpError(peer, client, r.status, r.body) };
  } catch (e) {
    return { ok: false, error: unreachable(peer, e) };
  }
}

/**
 * Hand a message to the peer daemon. Perspective flip: our 'to.device' becomes
 * the peer's local target. The peer records the sending device from OUR
 * certificate, not from this body (ADR-028).
 */
export async function relayToPeer(
  peer: Peer,
  message: Message,
  client: PeerClient,
): Promise<{ ok: boolean; error?: string }> {
  const wire = {
    contextId: message.contextId,
    from: { agent: message.from.agent, sessionId: message.from.sessionId },
    to: { agent: message.to.agent, sessionId: message.to.sessionId },
    text: message.parts.map((p) => p.text).join('\n'),
  };
  try {
    const r = await callPeer(peer, client, 'POST', '/api/peer/messages', wire);
    return r.status === 201 ? { ok: true } : { ok: false, error: httpError(peer, client, r.status, r.body) };
  } catch (e) {
    return { ok: false, error: unreachable(peer, e) };
  }
}
