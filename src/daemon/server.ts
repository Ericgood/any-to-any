import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import type { CollabStore } from '../collab/store.js';
import type { Peer } from '../cluster/peers.js';
import type { UntrustedContact } from '../cluster/secure-transport.js';
import type { TrustStore } from '../cluster/trust.js';
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
  /** Root for the external-agent registry (ADR-024); defaults to ~. Injectable for tests. */
  registryHome?: string;
  /** Drop the caller's directory cache. Called when an external agent registers,
   *  so it is addressable immediately instead of after the cache TTL — otherwise
   *  the first reply to a just-registered agent fails with a confusing not_found. */
  invalidateDirectory?: () => void;
  /** Pre-send check for a LOCAL target (ADR-025): non-null = refuse the send with
   *  409 and queue nothing, so the sender sees e.g. a CLI version mismatch now —
   *  instead of a silent dead letter whose cause the pull-hook recovery hides. */
  preflight?: (session: SessionInfo) => Promise<string | null>;
  /** LAN peering status for /api/peers. The peer API itself is served by the
   *  separate mutual-TLS peer server (ADR-028); this console stays loopback-only. */
  peering?: {
    selfDevice: string;
    selfId: string;
    /** Live LAN peer list (mDNS + static). */
    peers?: () => Peer[];
    trust?: TrustStore;
    /** Devices with a valid certificate that tried to talk to us but aren't paired. */
    pending?: () => UntrustedContact[];
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

/** Machine-readable code from a preflight error's `<code>: …` prefix. */
function preflightCode(error: string): string {
  return /^([a-z_]+):/.exec(error)?.[1] ?? 'preflight_failed';
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

/**
 * Optional narrowing for GET /api/sessions. The unfiltered directory is 4000+
 * sessions (~850KB) on a real machine — fine for the console, unusable inside an
 * agent's turn. With no query params the response is unchanged.
 */
function filterSessions(sessions: SessionInfo[], params: URLSearchParams): SessionInfo[] {
  const agent = params.get('agent');
  const q = params.get('q');
  const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : null;

  let out = sessions;
  if (agent) out = out.filter((s) => s.agent === agent.toLowerCase());
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(
      (s) => s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle),
    );
  }
  return limit === null ? out : out.slice(0, limit);
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
      // moved off the plaintext console onto the mutual-TLS peer port (ADR-028)
      json(res, 404, { error: 'the peer API is served over mutual TLS on the peer port (ADR-028)' });
      return;
    }

    // the console is bound to 127.0.0.1; keep the check as defence in depth
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
      json(res, 200, { sessions: filterSessions(await opts.directory(), url.searchParams) });
      return;
    }
    // ADR-024: external agents (desktop Apps like 闪电说) cannot run `anyd` — a
    // minimal PATH plus a sandbox that blocks writes to ~/.anytoany. They register
    // and pull over loopback HTTP instead, which the sandbox does not restrict.
    if (req.method === 'POST' && (path === '/api/register' || path === '/api/inbox')) {
      const body = (await readBody(req)) as {
        agent?: string;
        sessionId?: string;
        title?: string;
        cwd?: string;
        register?: boolean;
      };
      const isInbox = path === '/api/inbox';
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
        json(res, 400, { error: 'expected {agent, sessionId, title?, cwd?}' });
        return;
      }
      const { register, listRegistered } = await import('../registry/external.js');
      const homeOpt = opts.registryHome ? { home: opts.registryHome } : {};

      // /api/register always registers; /api/inbox only when asked — so one call
      // can register, refresh lastSeenAt and collect mail together.
      if (!isInbox || body.register) {
        if (typeof body.agent !== 'string') {
          json(res, 400, { error: 'expected {agent, sessionId, title?, cwd?}' });
          return;
        }
        let session;
        try {
          session = register(
            {
              agent: body.agent,
              sessionId: body.sessionId,
              ...(body.title ? { title: body.title } : {}),
              ...(body.cwd ? { cwd: body.cwd } : {}),
            },
            homeOpt,
          );
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
        opts.invalidateDirectory?.();
        if (!isInbox) {
          broadcast();
          json(res, 201, { session, registered: listRegistered(homeOpt).length });
          return;
        }
      }

      // Reuses the pull-hook collector, so external agents inherit dead-letter
      // recovery (ADR-022) for free. `text` is render-ready for the agent to read out.
      const { collectInbox } = await import('../hooks/prompt-hook.js');
      const messages = opts.mailbox.inbox({ toSession: body.sessionId, all: true });
      const before = new Set(messages.filter((m) => m.status === 'delivered').map((m) => m.id));
      const text = collectInbox(opts.mailbox, body.sessionId, homeOpt);
      const collected = opts.mailbox
        .inbox({ toSession: body.sessionId, all: true })
        .filter((m) => m.status === 'delivered' && !before.has(m.id));
      broadcast();
      json(res, 201, { count: collected.length, text, messages: collected });
      return;
    }
    if (req.method === 'GET' && path === '/api/peers') {
      if (!opts.peering) {
        json(res, 200, { lan: false, self: null, peers: [] });
        return;
      }
      const trust = opts.peering.trust;
      const peers = (opts.peering.peers?.() ?? []).map((p) => {
        const trusted = p.id ? trust?.get(p.id) : undefined;
        return { ...p, paired: Boolean(trusted), ...(trusted ? { trustedName: trusted.name } : {}) };
      });
      json(res, 200, {
        lan: true,
        self: { device: opts.peering.selfDevice, id: opts.peering.selfId },
        peers,
        trusted: trust?.list() ?? [],
        pending: opts.peering.pending?.() ?? [],
      });
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
    // Phase 4: create a shared plan for a conversation from the console (the
    // operator picks the lead). Idempotent — never clobbers an existing doc.
    const createMatch = /^\/api\/collab\/([0-9a-f-]+)\/create$/.exec(path);
    if (req.method === 'POST' && createMatch && createMatch[1]) {
      if (!opts.collab) {
        json(res, 404, { error: 'collab not enabled on this device' });
        return;
      }
      const body = (await readBody(req)) as { lead?: string; body?: string };
      if (typeof body.lead !== 'string' || !body.lead.trim()) {
        json(res, 400, { error: 'expected {lead: "@agent:title", body?}' });
        return;
      }
      const doc = await opts.collab.ensure({
        conversationId: createMatch[1],
        lead: body.lead,
        ...(typeof body.body === 'string' && body.body ? { body: body.body } : {}),
      });
      broadcast();
      json(res, 201, { doc });
      return;
    }
    // Phase 4: edit the plan body from the console (the operator writes as the lead).
    const planMatch = /^\/api\/collab\/([0-9a-f-]+)\/plan$/.exec(path);
    if (req.method === 'POST' && planMatch && planMatch[1]) {
      if (!opts.collab) {
        json(res, 404, { error: 'collab not enabled on this device' });
        return;
      }
      const doc = opts.collab.load(planMatch[1]);
      if (!doc) {
        json(res, 404, { error: `no collab doc for "${planMatch[1]}"` });
        return;
      }
      const body = (await readBody(req)) as { body?: string };
      if (typeof body.body !== 'string') {
        json(res, 400, { error: 'expected {body: "<plan markdown>"}' });
        return;
      }
      const updated = await opts.collab.setBody(planMatch[1], doc.lead, body.body);
      broadcast();
      json(res, 200, { doc: updated });
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
      // remote targets are checked by the owning daemon at delivery time
      const refused = !to.device && opts.preflight ? await opts.preflight(r.session) : null;
      if (refused) {
        json(res, 409, { error: refused, code: preflightCode(refused), resolvedTarget: r.session });
        return;
      }
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
      if (!body.to.device && opts.preflight) {
        const to = body.to;
        const target = (await opts.directory()).find(
          (s) => !s.device && s.agent === to.agent && s.sessionId === to.sessionId,
        );
        const refused = target ? await opts.preflight(target) : null;
        if (refused) {
          json(res, 409, { error: refused, code: preflightCode(refused) });
          return;
        }
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
  // loopback only, always: other devices reach us through the mutual-TLS peer server
  server.listen(port, '127.0.0.1');
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
