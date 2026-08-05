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

export interface DiscoveryOptions {
  selfDevice: string;
  port: number;
  token: string;
  /** Disable mDNS (tests / --peer only mode). */
  mdns?: boolean;
}

/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry {
  const peers = new Map<string, Peer>();
  const fp = tokenFingerprint(opts.token);
  let bonjour: Bonjour | null = null;

  if (opts.mdns !== false) {
    bonjour = new Bonjour();
    bonjour.publish({
      name: `anytoany-${opts.selfDevice}`,
      type: SERVICE_TYPE,
      port: opts.port,
      txt: { device: opts.selfDevice, fp },
    });
    const browser = bonjour.find({ type: SERVICE_TYPE });
    const upsert = (service: Service): void => {
      const txt = (service.txt ?? {}) as { device?: string; fp?: string };
      const device = txt.device;
      if (!device || device.toLowerCase() === opts.selfDevice.toLowerCase()) return;
      const host = service.addresses?.find((a) => a.includes('.')) ?? service.host;
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
  }

  return {
    list: () => [...peers.values()],
    get: (device) => peers.get(device.toLowerCase()),
    addStatic(device, host, port, peerFp) {
      peers.set(device.toLowerCase(), { device, host, port, fp: peerFp, lastSeenAt: Date.now() });
    },
    stop() {
      bonjour?.destroy();
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
