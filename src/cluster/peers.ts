import { Bonjour, type Service } from 'bonjour-service';
import type { SessionInfo } from '../adapters/types.js';
import type { Message } from '../mailbox/mailbox.js';
import { tokenFingerprint } from './token.js';

export interface Peer {
  device: string;
  host: string;
  port: number;
  /** Token fingerprint from mDNS TXT — equal to ours means paired. */
  fp: string;
  lastSeenAt: number;
}

export interface PeerRegistry {
  list(): Peer[];
  get(device: string): Peer | undefined;
  /** Manually add a peer (debugging / no-mDNS environments). */
  addStatic(device: string, host: string, port: number, fp: string): void;
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
  port: number;
  token: string;
  /** Disable mDNS (tests / --peer only mode). */
  mdns?: boolean;
  /** Browse without announcing — for passive CLI scans that have no real port. */
  publish?: boolean;
}

/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry {
  const peers = new Map<string, Peer>();
  const fp = tokenFingerprint(opts.token);
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
        txt: { device: opts.selfDevice, fp },
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
      const txt = (service.txt ?? {}) as { device?: string; fp?: string };
      const device = txt.device;
      if (!device || device.toLowerCase() === opts.selfDevice.toLowerCase()) return;
      const host = pickLanAddress(service.addresses ?? []) ?? service.host;
      if (!host) return;
      peers.set(device.toLowerCase(), {
        device,
        host,
        port: service.port,
        fp: txt.fp ?? '',
        lastSeenAt: Date.now(),
      });
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
    addStatic(device, host, port, peerFp) {
      peers.set(device.toLowerCase(), { device, host, port, fp: peerFp, lastSeenAt: Date.now() });
    },
    stop() {
      if (requery) clearInterval(requery);
      publisher?.destroy();
      finder?.destroy();
    },
  };
}

async function peerFetch(path: string, peer: Peer, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://${peer.host}:${peer.port}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-anytoany-token': token,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Pull a peer's local session directory, stamping each entry with its device. */
export async function fetchPeerSessions(peer: Peer, token: string): Promise<SessionInfo[]> {
  const res = await peerFetch('/api/peer/sessions', peer, token);
  if (!res.ok) throw new Error(`peer ${peer.device} sessions: HTTP ${res.status}`);
  const { sessions } = (await res.json()) as { sessions: SessionInfo[] };
  return sessions.map((s) => ({ ...s, device: peer.device }));
}

/**
 * Hand a message to the peer daemon. Perspective flip: our 'to.device' becomes
 * the peer's local target; our side becomes 'from.device' as seen by them.
 */
export async function relayToPeer(
  peer: Peer,
  message: Message,
  token: string,
  selfDevice: string,
): Promise<{ ok: boolean; error?: string }> {
  const wire = {
    contextId: message.contextId,
    from: { agent: message.from.agent, sessionId: message.from.sessionId, device: message.from.device ?? selfDevice },
    to: { agent: message.to.agent, sessionId: message.to.sessionId },
    text: message.parts.map((p) => p.text).join('\n'),
    via: 'relay',
  };
  try {
    const res = await peerFetch('/api/peer/messages', peer, token, {
      method: 'POST',
      body: JSON.stringify(wire),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: `peer ${peer.device}: HTTP ${res.status} ${body.error ?? ''}`.trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `peer ${peer.device} unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
