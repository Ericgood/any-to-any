import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import { parse as parseCollabDoc } from '../collab/doc.js';
import type { CollabStore } from '../collab/store.js';
import type { Peer } from '../cluster/peers.js';
import { tokenFingerprint } from '../cluster/token.js';
import type { Mailbox, SessionRef } from '../mailbox/mailbox.js';

const require = createRequire(import.meta.url);

export interface ConsoleServerOptions {
  mailbox: Mailbox;
  directory: () => Promise<SessionInfo[]>;
  port?: number;
  /** Collaboration-doc store (Phase 4) — surfaced read-only in the console. */
  collab?: CollabStore;
  /** Poll interval for external mailbox writers (CLI in another process). */
  changePollMs?: number;
  /** LAN peering (Phase 2): serve /api/peer/* and bind 0.0.0.0. */
  peering?: {
    selfDevice: string;
    token: string;
    /** Local-only directory (no peer aggregation) served to peers. */
    localDirectory: () => Promise<SessionInfo[]>;
    /** Live LAN peer list — served to the local CLI/webui at /api/peers. */
    peers?: () => Peer[];
  };
}

export interface RunningServer {
  port: number;
  notifyChange(): void;
  close(): void;
}

interface SendBody {
  from: SessionRef;
  to: SessionRef;
  text: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function isSessionRef(v: unknown): v is SessionRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SessionRef).agent === 'string' &&
    typeof (v as SessionRef).sessionId === 'string'
  );
}

/** Local-only web console: REST + SSE + static UI, bound to 127.0.0.1. */
export function startConsoleServer(opts: ConsoleServerOptions): RunningServer {
  const port = opts.port ?? 7433;
  const sseClients = new Set<ServerResponse>();
  const webuiFile = join(dirname(require.resolve('../../package.json')), 'webui', 'index.html');

  const broadcast = (): void => {
    for (const res of sseClients) res.write(`data: {"kind":"changed"}\n\n`);
  };

  // catch writes from other processes (anyd send in a shell, hooks, agents) —
  // including collab-doc edits (an agent appending progress via the CLI), so the
  // console's shared-plan panel stays live without a manual refresh.
  let lastStamp = '';
  const pollTimer = setInterval(() => {
    try {
      const msgs = opts.mailbox.inbox({ all: true });
      const last = msgs[msgs.length - 1];
      const stamp = `${msgs.length}:${last ? `${last.id}:${last.updatedAt}:${last.status}` : ''}`;
      const changedSince = msgs.reduce((acc, m) => Math.max(acc, m.updatedAt), 0);
      const collabStamp = opts.collab
        ? opts.collab.list().map((d) => `${d.conversationId}@${d.updated}`).join(',')
        : '';
      const full = `${stamp}:${changedSince}:${collabStamp}`;
      if (lastStamp && full !== lastStamp) broadcast();
      lastStamp = full;
    } catch {
      /* transient read errors must not kill the poller */
    }
  }, opts.changePollMs ?? 1500);

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;

    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

    if (path.startsWith('/api/peer/')) {
      if (!opts.peering) {
        json(res, 404, { error: 'peering disabled' });
        return;
      }
      const token = req.headers['x-anytoany-token'];
      if (token !== opts.peering.token) {
        json(res, 401, { error: 'invalid or missing cluster token' });
        return;
      }
      if (req.method === 'GET' && path === '/api/peer/info') {
        json(res, 200, { device: opts.peering.selfDevice });
        return;
      }
      if (req.method === 'GET' && path === '/api/peer/sessions') {
        json(res, 200, { sessions: await opts.peering.localDirectory() });
        return;
      }
      if (req.method === 'POST' && path === '/api/peer/messages') {
        const body = (await readBody(req)) as {
          contextId?: string;
          from?: SessionRef;
          to?: SessionRef;
          text?: string;
        };
        if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string') {
          json(res, 400, { error: 'expected {contextId?, from, to, text}' });
          return;
        }
        const m = opts.mailbox.send({
          from: body.from,
          to: { agent: body.to.agent, sessionId: body.to.sessionId }, // target is local here
          text: body.text,
          via: 'relay',
          ...(body.contextId ? { contextId: body.contextId } : {}),
        });
        broadcast();
        json(res, 201, { message: m });
        return;
      }
      // Phase 4 / M3: a peer pushes its copy of a collab doc; we merge convergently.
      if (req.method === 'POST' && path === '/api/peer/collab') {
        if (!opts.collab) {
          json(res, 404, { error: 'collab not enabled on this device' });
          return;
        }
        const body = (await readBody(req)) as { doc?: string };
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
        broadcast();
        json(res, 200, { doc: merged });
        return;
      }
      json(res, 404, { error: 'not found' });
      return;
    }

    // everything non-peer is local-only even when bound to 0.0.0.0 for peering
    if (!isLoopback) {
      json(res, 403, { error: 'local console endpoints are loopback-only' });
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(webuiFile, 'utf8'));
      return;
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      json(res, 200, { sessions: await opts.directory() });
      return;
    }
    if (req.method === 'GET' && path === '/api/peers') {
      if (!opts.peering) {
        json(res, 200, { lan: false, self: null, peers: [] });
        return;
      }
      const selfFp = tokenFingerprint(opts.peering.token);
      const peers = (opts.peering.peers?.() ?? []).map((p) => ({ ...p, paired: p.fp === selfFp }));
      json(res, 200, { lan: true, self: { device: opts.peering.selfDevice, fp: selfFp }, peers });
      return;
    }
    if (req.method === 'GET' && path === '/api/conversations') {
      json(res, 200, { conversations: opts.mailbox.listConversations() });
      return;
    }
    const msgsMatch = /^\/api\/conversations\/([0-9a-f-]+)\/messages$/.exec(path);
    if (req.method === 'GET' && msgsMatch && msgsMatch[1]) {
      json(res, 200, { messages: opts.mailbox.listMessages(msgsMatch[1]) });
      return;
    }
    // Phase 4: collab-doc list (for the conversation-list marker)
    if (req.method === 'GET' && path === '/api/collab') {
      const docs = (opts.collab?.list() ?? []).map((d) => ({
        conversationId: d.conversationId,
        lead: d.lead,
        updated: d.updated,
        tasks: d.tasks.length,
        open: d.tasks.filter((t) => t.state !== 'done' && t.state !== 'failed').length,
      }));
      json(res, 200, { docs });
      return;
    }
    // Phase 4: one collab doc — always 200; {doc:null} when absent (the console
    // asks for every selected conversation, most of which have no doc).
    const collabMatch = /^\/api\/collab\/([0-9a-f-]+)$/.exec(path);
    if (req.method === 'GET' && collabMatch && collabMatch[1]) {
      if (!opts.collab) {
        json(res, 200, { doc: null });
        return;
      }
      try {
        json(res, 200, { doc: opts.collab.load(collabMatch[1]) });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    // Phase 4 / M4: semi-automatic advance — nudge a task's owner to do the next
    // chunk. Operator-triggered (a console click), so it cannot self-loop.
    const advanceMatch = /^\/api\/collab\/([0-9a-f-]+)\/advance$/.exec(path);
    if (req.method === 'POST' && advanceMatch && advanceMatch[1]) {
      const conversationId = advanceMatch[1];
      if (!opts.collab) {
        json(res, 404, { error: 'collab not enabled on this device' });
        return;
      }
      const doc = opts.collab.load(conversationId);
      if (!doc) {
        json(res, 404, { error: `no collab doc for "${conversationId}"` });
        return;
      }
      const body = (await readBody(req)) as { taskId?: string; note?: string };
      const task = doc.tasks.find((t) => t.id === body.taskId);
      if (!task) {
        json(res, 422, { error: `task "${body.taskId ?? ''}" not found in this doc` });
        return;
      }
      const { resolveTarget } = await import('../directory/resolve.js');
      const r = resolveTarget(task.owner, await opts.directory());
      if (!r.ok) {
        json(res, 422, {
          error: `cannot resolve task owner "${task.owner}" (${r.reason})`,
          candidates: r.candidates.slice(0, 8),
        });
        return;
      }
      const to: SessionRef = { agent: r.session.agent, sessionId: r.session.sessionId };
      if (r.session.device) to.device = r.session.device;
      const nudge = [
        `Continue task ${task.id}${task.step ? ` (${task.step})` : ''} on the shared plan.`,
        `Read it: anyd collab show ${conversationId}. Do the next chunk you can finish this turn,`,
        `then log it: anyd collab progress ${conversationId} --as "${task.owner}" "<what you did + next>".`,
        body.note ?? '',
      ].join(' ').trim();
      // pin to the collab conversation when it's a real mailbox thread, so the
      // delivery envelope carries the shared-plan footer
      const known = opts.mailbox.listConversations().some((c) => c.id === conversationId);
      const m = opts.mailbox.send({
        from: { agent: 'user', sessionId: 'cli' },
        to,
        text: nudge,
        via: 'advance',
        ...(known ? { conversationId } : {}),
      });
      broadcast();
      json(res, 201, { message: m, to: r.session });
      return;
    }
    if (req.method === 'POST' && path === '/api/send') {
      const body = (await readBody(req)) as { target?: string; from?: SessionRef; text?: string };
      if (typeof body.target !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'expected {target, from?, text}' });
        return;
      }
      const { resolveTarget } = await import('../directory/resolve.js');
      const sessions = await opts.directory();
      const r = resolveTarget(body.target, sessions);
      if (!r.ok) {
        json(res, 422, {
          error: `cannot resolve target "${body.target}" (${r.reason})`,
          candidates: r.candidates.slice(0, 8),
        });
        return;
      }
      const to: SessionRef = { agent: r.session.agent, sessionId: r.session.sessionId };
      if (r.session.device) to.device = r.session.device;
      const from: SessionRef = isSessionRef(body.from) ? body.from : { agent: 'user', sessionId: 'cli' };
      const m = opts.mailbox.send({ from, to, text: body.text, via: 'cli' });
      broadcast();
      json(res, 201, { message: m, resolvedTarget: r.session });
      return;
    }
    if (req.method === 'POST' && path === '/api/messages') {
      const body = (await readBody(req)) as Partial<SendBody> & { conversationId?: string };
      if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'expected {from:{agent,sessionId}, to:{agent,sessionId}, text, conversationId?}' });
        return;
      }
      const m = opts.mailbox.send({
        from: body.from,
        to: body.to,
        text: body.text,
        via: 'webui',
        ...(typeof body.conversationId === 'string' && body.conversationId
          ? { conversationId: body.conversationId }
          : {}),
      });
      broadcast();
      json(res, 201, { message: m });
      return;
    }
    const retryMatch = /^\/api\/messages\/([0-9a-f-]+)\/retry$/.exec(path);
    if (req.method === 'POST' && retryMatch && retryMatch[1]) {
      const m = opts.mailbox.retry(retryMatch[1]);
      broadcast();
      json(res, 200, { message: m });
      return;
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: {"kind":"hello"}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  server.on('error', (e: NodeJS.ErrnoException) => {
    const hint = e.code === 'EADDRINUSE' ? ` — port ${port} already in use (another anyd running?)` : '';
    console.error(`console server error: ${e.message}${hint}`);
    process.exit(1);
  });
  server.listen(port, opts.peering ? '0.0.0.0' : '127.0.0.1');
  return {
    port,
    notifyChange: broadcast,
    close() {
      clearInterval(pollTimer);
      for (const c of sseClients) c.end();
      server.close();
    },
  };
}
