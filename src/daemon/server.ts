import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import type { Mailbox, SessionRef } from '../mailbox/mailbox.js';

const require = createRequire(import.meta.url);

export interface ConsoleServerOptions {
  mailbox: Mailbox;
  directory: () => Promise<SessionInfo[]>;
  port?: number;
  /** Poll interval for external mailbox writers (CLI in another process). */
  changePollMs?: number;
  /** LAN peering (Phase 2): serve /api/peer/* and bind 0.0.0.0. */
  peering?: {
    selfDevice: string;
    token: string;
    /** Local-only directory (no peer aggregation) served to peers. */
    localDirectory: () => Promise<SessionInfo[]>;
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

  // catch writes from other processes (anyd send in a shell, hooks, agents)
  let lastStamp = '';
  const pollTimer = setInterval(() => {
    try {
      const msgs = opts.mailbox.inbox({ all: true });
      const last = msgs[msgs.length - 1];
      const stamp = `${msgs.length}:${last ? `${last.id}:${last.updatedAt}:${last.status}` : ''}`;
      const changedSince = msgs.reduce((acc, m) => Math.max(acc, m.updatedAt), 0);
      const full = `${stamp}:${changedSince}`;
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
    if (req.method === 'GET' && path === '/api/conversations') {
      json(res, 200, { conversations: opts.mailbox.listConversations() });
      return;
    }
    const msgsMatch = /^\/api\/conversations\/([0-9a-f-]+)\/messages$/.exec(path);
    if (req.method === 'GET' && msgsMatch && msgsMatch[1]) {
      json(res, 200, { messages: opts.mailbox.listMessages(msgsMatch[1]) });
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
      const body = (await readBody(req)) as Partial<SendBody>;
      if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'expected {from:{agent,sessionId}, to:{agent,sessionId}, text}' });
        return;
      }
      const m = opts.mailbox.send({ from: body.from, to: body.to, text: body.text, via: 'webui' });
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
