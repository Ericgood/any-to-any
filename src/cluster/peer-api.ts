import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from '../adapters/types.js';
import { parse as parseCollabDoc } from '../collab/doc.js';
import type { CollabStore } from '../collab/store.js';
import type { Mailbox, SessionRef } from '../mailbox/mailbox.js';
import type { TrustedDevice } from './trust.js';

/**
 * Routes a paired device may call (ADR-028). Reached only through the mutual-TLS
 * peer server, which has already pinned the caller to an entry in our trust list —
 * so `peer` here is authenticated, and its trusted name (not anything in the body)
 * is what we record as the sending device.
 */

export interface PeerApiOptions {
  selfDevice: string;
  selfId?: string;
  mailbox: Mailbox;
  collab?: CollabStore;
  /** Local-only directory (no peer aggregation) served to peers. */
  localDirectory: () => Promise<SessionInfo[]>;
  /** Tell the local console something changed. */
  onChange?: () => void;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const isSessionRef = (v: unknown): v is SessionRef =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SessionRef).agent === 'string' &&
  typeof (v as SessionRef).sessionId === 'string' &&
  (v as SessionRef).sessionId.length > 0;

export function createPeerApiHandler(
  opts: PeerApiOptions,
): (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void> {
  return async (req, res, peer) => {
    const path = new URL(req.url ?? '/', 'https://peer').pathname;

    if (req.method === 'GET' && path === '/api/peer/info') {
      json(res, 200, { device: opts.selfDevice, ...(opts.selfId ? { id: opts.selfId } : {}) });
      return;
    }
    if (req.method === 'GET' && path === '/api/peer/sessions') {
      json(res, 200, { sessions: await opts.localDirectory() });
      return;
    }
    if (req.method === 'POST' && path === '/api/peer/messages') {
      const body = (await readBody(req)) as { contextId?: unknown; from?: unknown; to?: unknown; text?: unknown };
      if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string') {
        json(res, 400, { error: 'expected {contextId?, from, to, text}' });
        return;
      }
      const m = opts.mailbox.send({
        // the authenticated device, not whatever the body claims
        from: { agent: body.from.agent, sessionId: body.from.sessionId, device: peer.name },
        to: { agent: body.to.agent, sessionId: body.to.sessionId }, // target is local here
        text: body.text,
        via: 'relay',
        ...(typeof body.contextId === 'string' && body.contextId ? { contextId: body.contextId } : {}),
      });
      opts.onChange?.();
      json(res, 201, { message: m });
      return;
    }
    // Phase 4 / M3: a peer pushes its copy of a collab doc; we merge convergently.
    if (req.method === 'POST' && path === '/api/peer/collab') {
      if (!opts.collab) {
        json(res, 404, { error: 'collab not enabled on this device' });
        return;
      }
      const body = (await readBody(req)) as { doc?: unknown };
      if (typeof body.doc !== 'string') {
        json(res, 400, { error: 'expected {doc: <serialized markdown>}' });
        return;
      }
      let incoming;
      try {
        incoming = parseCollabDoc(body.doc);
      } catch (e) {
        json(res, 400, { error: `unparseable collab doc: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      const merged = await opts.collab.merge(incoming);
      opts.onChange?.();
      json(res, 200, { doc: merged });
      return;
    }
    json(res, 404, { error: 'not found' });
  };
}
