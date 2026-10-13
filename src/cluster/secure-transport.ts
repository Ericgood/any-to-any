import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { deviceIdFromCert, type DeviceIdentity } from './identity.js';
import type { TrustedDevice, TrustStore } from './trust.js';

/**
 * Device-to-device transport (ADR-028): mutual TLS 1.3, each side pinning the
 * other's certificate fingerprint against its own trust list — no CA, no shared
 * secret. The client checks who answered BEFORE sending a single byte of the
 * request; the server checks who called before any route runs.
 */

const MIN_TLS = 'TLSv1.3';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Self-reported name, used only to label a pairing request — never trusted. */
const DEVICE_HEADER = 'x-anytoany-device';

export interface UntrustedContact {
  id: string;
  claimedName?: string;
  address?: string;
  at: number;
}

export interface PeerServerOptions {
  identity: DeviceIdentity;
  trust: TrustStore;
  port: number;
  host?: string;
  handle: (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void>;
  /** A device with a valid certificate that isn't paired yet — surfaced as a pairing request. */
  onUntrusted?: (contact: UntrustedContact) => void;
}

export interface PeerServer {
  port: number;
  close(): void;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const certIdOf = (socket: TLSSocket): string | null => {
  const cert = socket.getPeerCertificate();
  return cert && cert.raw ? deviceIdFromCert(cert.raw) : null;
};

export async function startPeerServer(opts: PeerServerOptions): Promise<PeerServer> {
  const server = createServer(
    {
      key: opts.identity.keyPem,
      cert: opts.identity.certPem,
      requestCert: true,
      // chain validation is meaningless for self-signed peers — we pin fingerprints below
      rejectUnauthorized: false,
      minVersion: MIN_TLS,
    },
    (req, res) => {
      const id = certIdOf(req.socket as TLSSocket);
      if (!id) {
        reply(res, 401, { error: 'client certificate required (anytoany device identity, ADR-028)' });
        return;
      }
      const peer = opts.trust.get(id);
      if (!peer) {
        const claimed = req.headers[DEVICE_HEADER];
        opts.onUntrusted?.({
          id,
          ...(typeof claimed === 'string' && claimed ? { claimedName: claimed.slice(0, 64) } : {}),
          ...(req.socket.remoteAddress ? { address: req.socket.remoteAddress } : {}),
          at: Date.now(),
        });
        reply(res, 403, { error: `device ${id} is not paired with this device — run: anyd pair add ${id}`, selfId: opts.identity.id });
        return;
      }
      opts.handle(req, res, peer).catch((e: unknown) => {
        if (!res.headersSent) reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
      });
    },
  );
  server.listen(opts.port, opts.host ?? '0.0.0.0');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : opts.port,
    close: () => server.close(),
  };
}

/** Open a TLS connection presenting our identity; resolve once handshaken. */
async function openTls(host: string, port: number, identity: DeviceIdentity, timeoutMs: number): Promise<TLSSocket> {
  const socket = connect({
    host,
    port,
    key: identity.keyPem,
    cert: identity.certPem,
    rejectUnauthorized: false, // pinned by fingerprint instead — see callers
    minVersion: MIN_TLS,
  });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`peer ${host}:${port} timed out after ${timeoutMs}ms`)));
  await Promise.race([
    once(socket, 'secureConnect'),
    once(socket, 'error').then(([e]) => {
      throw e;
    }),
  ]);
  return socket;
}

/** Which device answers at this address? (static peers, pairing hints) */
export async function probePeerId(opts: { host: string; port: number; identity: DeviceIdentity; timeoutMs?: number }): Promise<string> {
  const socket = await openTls(opts.host, opts.port, opts.identity, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const id = certIdOf(socket);
    if (!id) throw new Error(`peer ${opts.host}:${opts.port} presented no certificate`);
    return id;
  } finally {
    socket.destroy();
  }
}

export interface PeerRequestOptions {
  host: string;
  port: number;
  /** The device we mean to talk to — anything else is dropped before sending. */
  expectedId: string;
  identity: DeviceIdentity;
  /** Our device name, shown to an unpaired peer as the pairing request's label. */
  selfName: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/** One JSON request over pinned mutual TLS. */
export async function peerRequest(opts: PeerRequestOptions): Promise<{ status: number; body: unknown }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await openTls(opts.host, opts.port, opts.identity, timeoutMs);
  const presented = certIdOf(socket);
  if (presented !== opts.expectedId) {
    socket.destroy();
    throw new Error(
      `peer identity mismatch at ${opts.host}:${opts.port}: expected ${opts.expectedId}, got ${presented ?? 'no certificate'} — not sending (ADR-028)`,
    );
  }
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method: opts.method,
        path: opts.path,
        host: opts.host,
        // no `agent` on purpose: with one set, Node ignores createConnection
        createConnection: () => socket, // the socket we already verified
        headers: {
          [DEVICE_HEADER]: opts.selfName,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          socket.destroy();
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* non-JSON error page — keep the text */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', (e) => {
      socket.destroy();
      reject(e);
    });
    req.end(payload);
  });
}
