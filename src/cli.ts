#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createKimiAdapter } from './adapters/kimi.js';
import { createZcodeAdapter } from './adapters/zcode.js';
import { serialize as serializeCollab, TASK_STATES, type CollabDoc, type CollabTask, type TaskState } from './collab/doc.js';
import { createCollabStore } from './collab/store.js';
import { resolveTarget } from './directory/resolve.js';
import { listAllSessions } from './directory/scanner.js';
import { formatRelativeTime, shortenHome } from './format.js';
import { createDb } from './mailbox/db.js';
import { createMailbox, type Message, type SessionRef } from './mailbox/mailbox.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const defaultAdapters = () => [
  createClaudeAdapter(),
  createCodexAdapter(),
  createZcodeAdapter(),
  createKimiAdapter(),
];
const openMailbox = () => createMailbox(createDb());

/** Resolve an @-target into a concrete session, printing candidates on failure. */
async function resolveOrExit(target: string): Promise<SessionRef & { title: string }> {
  const { sessions } = await listAllSessions(defaultAdapters());
  const r = resolveTarget(target, sessions);
  if (r.ok) {
    return { agent: r.session.agent, sessionId: r.session.sessionId, title: r.session.title };
  }
  console.error(`error: cannot resolve target "${target}" (${r.reason})`);
  for (const c of r.candidates.slice(0, 8)) {
    console.error(`  candidate: @${c.agent}:${c.title}  [${c.sessionId.slice(0, 8)}]`);
  }
  process.exit(1);
}

function printMessage(m: Message): void {
  const text = m.parts.map((p) => p.text).join('\n');
  console.log(
    `[${m.id.slice(0, 8)}] ${m.status}  @${m.from.agent} → @${m.to.agent}:${m.to.sessionId.slice(0, 8)}  ${JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text)}`,
  );
}

/** Agent labels are opaque doc keys; just guarantee a leading '@'. */
const normalizeLabel = (s: string): string => (s.startsWith('@') ? s : `@${s}`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Human-readable rendering of a collaboration doc for `anyd collab show`. */
function printCollabDoc(doc: CollabDoc): void {
  console.log(`● collab ${doc.conversationId}`);
  console.log(`  lead: ${doc.lead}   updated: ${doc.updated}`);
  if (doc.tasks.length) {
    console.log('  tasks:');
    for (const t of doc.tasks) {
      const badge = t.step ? `${t.state} ${t.step}` : t.state;
      console.log(`    [${badge}] ${t.id} ${t.owner}${t.note ? ` — ${t.note}` : ''}`);
    }
  }
  if (doc.body) {
    console.log('  ── plan ──');
    for (const line of doc.body.split('\n')) console.log(`  ${line}`);
  }
  for (const section of doc.progress) {
    console.log(`  ── progress · ${section.agent} ──`);
    for (const e of section.entries) console.log(`  - ${e}`);
  }
}

const program = new Command();

program
  .name('anyd')
  .description('anytoany — session-to-session messaging for AI coding agents')
  .version(version);

const notImplemented = (cmd: string) => () => {
  console.error(`anyd ${cmd}: not implemented yet (Phase 1 in progress)`);
  process.exitCode = 1;
};

program
  .command('start')
  .description('Start the anyd daemon (foreground) — delivers messages + serves the web console')
  .option('--interval <ms>', 'mailbox poll interval', '1000')
  .option('--directory-ttl <ms>', 'session directory cache TTL', '30000')
  .option('--port <port>', 'web console port', '7433')
  .option('--no-web', 'disable the web console server')
  .option('--no-lan', 'disable LAN peering (mDNS + relay)')
  .option('--no-notify', 'disable macOS notifications on new cross-agent traffic')
  .option('--peer <host:port...>', 'manually add peer daemons (skips mDNS discovery for them)')
  .action(async (opts: { interval: string; directoryTtl: string; port: string; web: boolean; lan: boolean; notify: boolean; peer?: string[] }) => {
    const adapters = defaultAdapters();
    const mailbox = openMailbox();
    const port = Number.parseInt(opts.port, 10) || 7433;

    let cache: { at: number; sessions: Awaited<ReturnType<typeof listAllSessions>>['sessions'] } | null = null;
    const ttl = Number.parseInt(opts.directoryTtl, 10) || 30_000;
    const localDirectory = async () => {
      if (!cache || Date.now() - cache.at > ttl) {
        const { sessions, errors } = await listAllSessions(adapters);
        for (const e of errors) console.error(`warning: ${e.agent} scan failed: ${e.error.message}`);
        cache = { at: Date.now(), sessions };
      }
      return cache.sessions;
    };

    // LAN peering (Phase 2): discovery + remote directory aggregation + relay
    let lan: {
      selfDevice: string;
      token: string;
      registry: import('./cluster/peers.js').PeerRegistry;
      relay: NonNullable<import('./daemon/dispatcher.js').DispatcherOptions['relay']>;
    } | null = null;
    if (opts.lan) {
      const { loadOrCreateToken, tokenFingerprint } = await import('./cluster/token.js');
      const { getDeviceName } = await import('./cluster/device.js');
      const { startPeerRegistry, fetchPeerSessions, relayToPeer } = await import('./cluster/peers.js');
      const token = loadOrCreateToken();
      const selfDevice = getDeviceName();
      const registry = startPeerRegistry({ selfDevice, port, token });
      for (const spec of opts.peer ?? []) {
        const [host, p] = spec.split(':');
        if (!host || !p) continue;
        const peerPort = Number.parseInt(p, 10);
        // resolve the peer's real device name so reply routing can find it
        try {
          const res = await fetch(`http://${host}:${peerPort}/api/peer/info`, {
            headers: { 'x-anytoany-token': token },
            signal: AbortSignal.timeout(5000),
          });
          const info = (await res.json()) as { device?: string };
          registry.addStatic(info.device ?? host, host, peerPort, tokenFingerprint(token));
          console.log(`lan: static peer @${info.device ?? host} (${host}:${peerPort})`);
        } catch {
          console.error(`warning: static peer ${spec} unreachable at startup — will not be usable until restart`);
        }
      }
      lan = {
        selfDevice,
        token,
        registry,
        relay: async (device, message) => {
          const peer = registry.get(device);
          if (!peer) return { ok: false, error: `device "${device}" not found on LAN (anyd peers to inspect)` };
          return relayToPeer(peer, message, token, selfDevice);
        },
      };
      console.log(`lan: device "${selfDevice}" fp ${tokenFingerprint(token)} — mDNS on, peers aggregate into directory`);
    }

    const directory = async () => {
      const local = await localDirectory();
      let all = local;
      if (lan) {
        const { fetchPeerSessions } = await import('./cluster/peers.js');
        const remotes = await Promise.allSettled(
          lan.registry.list().map((p) => fetchPeerSessions(p, lan!.token)),
        );
        const remoteSessions = remotes.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        all = [...local, ...remoteSessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      }
      // Phase 2.5: keep the @any- mention agents in step with the live directory
      try {
        const { syncMentionAgents } = await import('./cluster/sync-agents.js');
        const { written, removed } = await syncMentionAgents(all, mailbox.listConversations());
        if (written.length || removed.length) {
          console.log(`mention agents: +${written.length} -${removed.length} (~/.claude/agents/any-*)`);
        }
      } catch (e) {
        console.error(`warning: mention agent sync failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return all;
    };

    const { writePid, clearPid, readPid, isAlive } = await import('./daemon/pidfile.js');
    const existing = readPid();
    if (existing && isAlive(existing) && existing !== process.pid) {
      console.error(`daemon already running (pid ${existing}) — stop it first with anyd stop`);
      process.exit(1);
    }
    // A live console on our port means another anyd owns this machine even if
    // its pid file is gone — bail BEFORE touching the pid file, or our exit
    // cleanup would erase the survivor's record.
    if (opts.web || lan) {
      const occupied = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        signal: AbortSignal.timeout(1500),
      }).then(
        () => true,
        () => false,
      );
      if (occupied) {
        console.error(`port ${port} is already serving — another anyd is running (anyd stop first)`);
        process.exit(1);
      }
    }
    writePid();
    process.on('exit', () => clearPid(process.pid));

    const stale = mailbox.recoverStale();
    if (stale > 0) console.log(`recovered ${stale} message(s) stranded by a previous daemon run`);

    const { createNotifier } = await import('./daemon/notify.js');
    const notifier = createNotifier({ enabled: opts.notify });

    console.log(`anyd ${version} — daemon starting (poll ${opts.interval}ms)`);
    const initial = await directory();
    console.log(`directory: ${initial.length} sessions discovered`);

    const collab = createCollabStore();
    let web: { notifyChange(): void; close(): void; port: number } | null = null;
    if (opts.web || lan) {
      const { startConsoleServer } = await import('./daemon/server.js');
      web = startConsoleServer({
        mailbox,
        directory,
        collab,
        port,
        ...(lan
          ? {
              peering: {
                selfDevice: lan.selfDevice,
                token: lan.token,
                localDirectory,
                peers: () => lan?.registry.list() ?? [],
              },
            }
          : {}),
      });
      console.log(`web console: http://127.0.0.1:${web.port}`);
    }

    const { startDispatcher } = await import('./daemon/dispatcher.js');
    const { isMonitored } = await import('./daemon/monitor.js');
    const running = startDispatcher(
      {
        mailbox,
        adapters: new Map(adapters.map((a) => [a.agent, a])),
        directory,
        collab,
        isMonitored: (sid) => isMonitored(sid),
        ...(lan ? { selfDevice: lan.selfDevice, relay: lan.relay } : {}),
        onEvent: (e) => {
          const m = e.message;
          const line = `[${new Date().toISOString()}] ${e.kind} ${m.id.slice(0, 8)} @${m.from.agent} → @${m.to.device ?? 'local'}/${m.to.agent}${e.detail ? ` — ${e.detail}` : ''}`;
          console.log(line);
          web?.notifyChange();
          if (e.kind === 'delivered' && !m.to.device) {
            const title = cache?.sessions.find((s) => s.sessionId === m.to.sessionId)?.title ?? m.to.sessionId.slice(0, 8);
            notifier.sessionActivity(m.to.agent, title, m.to.sessionId, 'received');
          }
        },
      },
      { intervalMs: Number.parseInt(opts.interval, 10) || 1000 },
    );

    const shutdown = () => {
      console.log('anyd daemon stopping');
      running.stop();
      lan?.registry.stop();
      web?.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {
      /* run until signalled */
    });
  });
program
  .command('stop')
  .description('Stop the anyd daemon')
  .action(async () => {
    const { readPid, clearPid } = await import('./daemon/pidfile.js');
    let pid = readPid();
    if (!pid) {
      // pid file lost (crashed starter, manual delete) — find the daemon by name
      const { execSync } = await import('node:child_process');
      try {
        const out = execSync('pgrep -f "anyd start"', { encoding: 'utf8' });
        const found = out
          .split('\n')
          .map((l) => Number.parseInt(l, 10))
          .filter((n) => Number.isFinite(n) && n !== process.pid);
        pid = found[0] ?? null;
      } catch {
        pid = null; // pgrep exits non-zero when nothing matches
      }
      if (!pid) {
        console.log('daemon not running (no pid file, no process)');
        return;
      }
      console.log(`pid file missing — found daemon by process name (pid ${pid})`);
    }
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`sent SIGTERM to daemon (pid ${pid})`);
    } catch {
      console.log(`daemon pid ${pid} not alive — cleaning pid file`);
    }
    clearPid();
  });
program
  .command('status')
  .description('Show daemon status and delivery stats')
  .action(async () => {
    const { readPid, isAlive } = await import('./daemon/pidfile.js');
    const pid = readPid();
    const running = pid !== null && isAlive(pid);
    console.log(`daemon: ${running ? `running (pid ${pid})` : 'not running'}`);
    const counts = openMailbox()
      .inbox({ all: true })
      .reduce<Record<string, number>>((acc, m) => {
        acc[m.status] = (acc[m.status] ?? 0) + 1;
        return acc;
      }, {});
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`mailbox: ${total} messages${total ? ` — ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}`);
  });
program
  .command('flush')
  .description('Deliver all queued messages once, then exit (no daemon needed)')
  .action(async () => {
    const adapters = defaultAdapters();
    const { sessions } = await listAllSessions(adapters);
    const { dispatchOnce } = await import('./daemon/dispatcher.js');
    const opts = {
      mailbox: openMailbox(),
      adapters: new Map(adapters.map((a) => [a.agent, a])),
      directory: async () => sessions,
      collab: createCollabStore(),
      onEvent: (e: { kind: string; message: { id: string }; detail?: string }) =>
        console.log(`${e.kind} ${e.message.id.slice(0, 8)}${e.detail ? ` — ${e.detail}` : ''}`),
    };
    let n = 0;
    while (await dispatchOnce(opts)) n++;
    console.log(`flushed ${n} message(s)`);
  });
program
  .command('hook')
  .description('Hook processors wired into agent CLIs (internal)')
  .argument('<kind>', 'hook kind: claude-prompt-submit | codex-prompt-submit')
  .action(async (kind: string) => {
    if (kind !== 'claude-prompt-submit' && kind !== 'codex-prompt-submit') {
      console.error(`unknown hook kind: ${kind}`);
      process.exitCode = 1;
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    let input: { session_id?: string; thread_id?: string } = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { session_id?: string; thread_id?: string };
    } catch {
      /* tolerate malformed hook payloads — emit no context */
    }
    const { processPromptHook } = await import('./hooks/prompt-hook.js');
    console.log(JSON.stringify(processPromptHook(openMailbox(), input)));
  });
program
  .command('pair')
  .description('Show or set the LAN cluster token (same token on every device = paired)')
  .option('--show', 'print this device token and pairing command for other devices')
  .option('--set <token>', 'join a cluster by writing its token')
  .option('--name <device>', 'set this device display name')
  .option('--invite', 'print a copy-paste one-liner that installs + joins from another device')
  .action(async (opts: { show?: boolean; set?: string; name?: string; invite?: boolean }) => {
    const { loadOrCreateToken, setToken, tokenFingerprint } = await import('./cluster/token.js');
    const { getDeviceName, setDeviceName } = await import('./cluster/device.js');
    if (opts.name) {
      setDeviceName(opts.name);
      console.log(`device name set: ${opts.name}`);
    }
    if (opts.set) {
      setToken(opts.set);
      console.log(`cluster token saved (fp ${tokenFingerprint(opts.set)}) — restart anyd start to apply`);
      return;
    }
    const token = loadOrCreateToken();
    if (opts.invite) {
      console.log(`Paste this into the other device's terminal — or hand it to any agent there:\n`);
      console.log(`  curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash -s -- --join ${token}\n`);
      console.log(`It installs anytoany, joins this cluster, and configures the agents.`);
      console.log(`Then start the daemon there:  anyd start`);
      return;
    }
    console.log(`device: ${getDeviceName()}`);
    console.log(`token fingerprint: ${tokenFingerprint(token)}`);
    if (opts.show) {
      console.log(`\non the other device, run:\n  anyd pair --set ${token}`);
    } else {
      console.log(`use --invite for a copy-paste installer one-liner, --show for the raw token`);
    }
  });
program
  .command('peers')
  .description('List LAN peers discovered via mDNS (asks the running daemon; passive scan as fallback)')
  .option('--port <port>', 'local daemon console port', '7433')
  .action(async (opts: { port: string }) => {
    const { loadOrCreateToken, tokenFingerprint } = await import('./cluster/token.js');
    const { getDeviceName } = await import('./cluster/device.js');
    const fp = tokenFingerprint(loadOrCreateToken());
    const port = Number.parseInt(opts.port, 10) || 7433;

    interface PeerRow {
      device: string;
      host: string;
      port: number;
      fp: string;
      paired?: boolean;
    }
    let peers: PeerRow[] | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/peers`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = (await res.json()) as { lan: boolean; peers: PeerRow[] };
        if (!body.lan) {
          console.log('daemon is running with LAN peering disabled (--no-lan)');
          return;
        }
        peers = body.peers;
      }
    } catch {
      /* daemon not running or older build — fall back to a passive scan */
    }
    if (peers === null) {
      const { startPeerRegistry } = await import('./cluster/peers.js');
      const registry = startPeerRegistry({
        selfDevice: getDeviceName(),
        port: 0,
        token: loadOrCreateToken(),
        publish: false, // browse-only: a CLI scan has no console port to announce
      });
      console.log('daemon not reachable — passive mDNS scan for 3s…');
      await new Promise((r) => setTimeout(r, 3000));
      peers = registry.list();
      registry.stop();
    }
    console.log(`self: @${getDeviceName()}  fp ${fp}`);
    if (peers.length === 0) {
      console.log('no peers found (is anyd start running on the other device? same network?)');
      return;
    }
    for (const p of peers) {
      const isPaired = p.paired ?? p.fp === fp;
      const status = isPaired
        ? 'paired'
        : `NOT paired — run anyd pair --show here, then anyd pair --set <token> on @${p.device} and restart anyd there`;
      console.log(`@${p.device}  ${p.host}:${p.port}  ${status}`);
    }
  });
program
  .command('doctor')
  .description('Check environment readiness for anytoany')
  .action(async () => {
    const { runDoctor } = await import('./doctor.js');
    process.exitCode = (await runDoctor()) ? 0 : 1;
  });
program
  .command('setup')
  .description('Install the any-to-any skill into agent CLIs and register the Claude hook')
  .option('--no-hook', 'skip Claude settings.json hook registration')
  .action(async (opts: { hook: boolean }) => {
    const { runSetup } = await import('./setup.js');
    await runSetup({ withHook: opts.hook });
  });
program
  .command('list')
  .description('List addressable sessions discovered on this machine')
  .option('--json', 'output as JSON')
  .option('--limit <n>', 'max sessions to show (0 = all)', '20')
  .action(async (opts: { json?: boolean; limit: string }) => {
    const { sessions, errors } = await listAllSessions(defaultAdapters());
    const limit = Number.parseInt(opts.limit, 10) || 0;
    const shown = limit > 0 ? sessions.slice(0, limit) : sessions;

    if (opts.json) {
      console.log(
        JSON.stringify(
          { sessions: shown, total: sessions.length, errors: errors.map((e) => ({ agent: e.agent, message: e.error.message })) },
          null,
          2,
        ),
      );
      return;
    }
    for (const s of shown) {
      const id = s.sessionId.slice(0, 8);
      const prefix = s.device ? `@${s.device}/` : '@';
      console.log(`${prefix}${s.agent}:${s.title}  [${id}]  (${formatRelativeTime(s.lastActiveAt)}, ${shortenHome(s.cwd)})`);
    }
    if (sessions.length > shown.length) {
      console.log(`… ${sessions.length - shown.length} more (use --limit 0 for all)`);
    }
    for (const e of errors) {
      console.error(`warning: ${e.agent} scan failed: ${e.error.message}`);
    }
  });
program
  .command('send')
  .description('Send a message to a session, e.g. anyd send "@codex:frontend" "hello"')
  .argument('<target>', 'target session, @<agent>[:<session>]')
  .argument('<message>', 'message text')
  .option('--from <self>', 'sender identity, @<agent>:<session> (resolved like a target)')
  .option('--port <port>', 'daemon port for delegation', '7433')
  .action(async (target: string, message: string, opts: { from?: string; port: string }) => {
    const from: SessionRef = opts.from
      ? await resolveOrExit(opts.from)
      : { agent: 'user', sessionId: 'cli' };

    // prefer the daemon: its directory aggregates LAN peers, so @device/… resolves
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, from, text: message }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        message?: Message;
        resolvedTarget?: { agent: string; title: string; sessionId: string; device?: string };
        error?: string;
        candidates?: Array<{ agent: string; title: string; sessionId: string; device?: string }>;
      };
      if (res.ok && body.message && body.resolvedTarget) {
        const t = body.resolvedTarget;
        console.log(`queued ${body.message.id}`);
        console.log(`  to: ${t.device ? `@${t.device}/` : '@'}${t.agent}:${t.title} [${t.sessionId.slice(0, 8)}]`);
        return;
      }
      console.error(`error: ${body.error ?? `daemon returned ${res.status}`}`);
      for (const c of body.candidates ?? []) {
        console.error(`  candidate: ${c.device ? `@${c.device}/` : '@'}${c.agent}:${c.title}  [${c.sessionId.slice(0, 8)}]`);
      }
      process.exit(1);
    } catch {
      // daemon not running — local-only fallback (no LAN targets)
      const to = await resolveOrExit(target);
      const m = openMailbox().send({ from, to, text: message });
      console.log(`queued ${m.id} (daemon offline — local resolution only)`);
      console.log(`  to: @${to.agent}:${to.title} [${to.sessionId.slice(0, 8)}]`);
      console.log(`  delivery starts once the daemon is running (anyd start)`);
    }
  });
program
  .command('inbox')
  .description('Show undelivered messages (delivery pipeline lands in M3)')
  .option('--session <target>', 'filter by recipient, @<agent>[:<session>]')
  .option('--take', 'mark listed messages as delivered (recipient pull mode)')
  .option('--all', 'include delivered/dead messages')
  .option('--json', 'output as JSON')
  .action(async (opts: { session?: string; take?: boolean; all?: boolean; json?: boolean }) => {
    const query: { toSession?: string; take?: boolean; all?: boolean } = {};
    if (opts.session) query.toSession = (await resolveOrExit(opts.session)).sessionId;
    if (opts.take) query.take = true;
    if (opts.all) query.all = true;
    const messages = openMailbox().inbox(query);
    if (opts.json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }
    if (messages.length === 0) {
      console.log('inbox empty');
      return;
    }
    for (const m of messages) printMessage(m);
  });
program
  .command('pull')
  .description('Pull new anytoany messages for THIS session from disk — manual reload, no restart needed')
  .option('--session <target>', 'pull for a specific session instead of auto-detecting by directory')
  .option('--cwd <dir>', 'directory used to identify your session (default: current directory)')
  .option('--quiet', 'print nothing when there is nothing new (for proactive/auto pulls)')
  .option('--history', 'SEE the recent cross-agent exchange in full (read-only, ignores cursor) — even messages already delivered/handled')
  .option('--limit <n>', 'with --history, how many recent messages to show', '15')
  .action(async (opts: { session?: string; cwd?: string; quiet?: boolean; history?: boolean; limit?: string }) => {
    const mailbox = openMailbox();
    const { collectInbox, recentExchange } = await import('./hooks/prompt-hook.js');
    let targets: Array<{ id: string; label: string }> = [];
    if (opts.session) {
      const s = await resolveOrExit(opts.session);
      targets = [{ id: s.sessionId, label: `@${s.agent}:${s.title}` }];
    } else {
      const cwd = opts.cwd ?? process.cwd();
      const { sessions } = await listAllSessions(defaultAdapters());
      const matches = sessions.filter((s) => s.cwd === cwd);
      if (matches.length === 0) {
        if (!opts.quiet) {
          console.log(`no session found for ${cwd} — open a session here, or pass --session "@<agent>:<fragment>"`);
        }
        return;
      }
      targets = matches.map((s) => ({ id: s.sessionId, label: `@${s.agent}:${s.title}` }));
    }
    // --history: read-only view of the recent exchange, so you can SEE what
    // happened even after it was delivered headlessly and the cursor moved on.
    if (opts.history) {
      const limit = Number.parseInt(opts.limit ?? '15', 10) || 15;
      let shown = false;
      for (const t of targets) {
        const text = recentExchange(mailbox, t.id, limit);
        if (text) {
          console.log(`===== ${t.label} =====`);
          console.log(text);
          console.log('');
          shown = true;
        }
      }
      if (!shown && !opts.quiet) console.log('no anytoany history for this session yet.');
      return;
    }
    let any = false;
    for (const t of targets) {
      const text = collectInbox(mailbox, t.id);
      if (text) {
        console.log(`===== ${t.label} =====`);
        console.log(text);
        console.log('');
        any = true;
      }
    }
    if (!any && !opts.quiet) {
      console.log('no new anytoany messages — run `anyd pull --history` to see the recent exchange (delivered ones included).');
    }
  });
program
  .command('monitor')
  .description('Receive messages LIVE in this session — blocks until one arrives, prints it here (no headless resume, no manual reload)')
  .option('--session <target>', 'monitor a specific session instead of auto-detecting by directory')
  .option('--cwd <dir>', 'directory used to identify your session (default: current directory)')
  .option('--timeout <s>', 'stop waiting after this many seconds (then just run monitor again)', '1800')
  .option('--poll <ms>', 'poll interval', '1500')
  .action(async (opts: { session?: string; cwd?: string; timeout?: string; poll?: string }) => {
    const mailbox = openMailbox();
    const { collectInbox } = await import('./hooks/prompt-hook.js');
    const { heartbeat, clearMonitor } = await import('./daemon/monitor.js');
    let targets: Array<{ id: string; label: string }> = [];
    if (opts.session) {
      const s = await resolveOrExit(opts.session);
      targets = [{ id: s.sessionId, label: `@${s.agent}:${s.title}` }];
    } else {
      const cwd = opts.cwd ?? process.cwd();
      const { sessions } = await listAllSessions(defaultAdapters());
      const matches = sessions.filter((s) => s.cwd === cwd);
      if (matches.length === 0) {
        console.log(`no session found for ${cwd} — open a session here, or pass --session "@<agent>:<fragment>"`);
        return;
      }
      targets = matches.map((s) => ({ id: s.sessionId, label: `@${s.agent}:${s.title}` }));
    }
    const timeoutMs = (Number.parseInt(opts.timeout ?? '1800', 10) || 1800) * 1000;
    const pollMs = Number.parseInt(opts.poll ?? '1500', 10) || 1500;
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    // clear heartbeats on ANY exit path (normal return, Ctrl-C, kill) so the
    // daemon resumes normal delivery promptly instead of waiting for staleness
    const cleanup = (): void => {
      for (const t of targets) clearMonitor(t.id);
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => process.exit(130));
    process.once('SIGTERM', () => process.exit(143));
    console.log(`monitoring ${targets.map((t) => t.label).join(', ')} — waiting for messages…`);
    for (;;) {
      for (const t of targets) heartbeat(t.id); // tell the daemon: don't resume-deliver to me
      let got = false;
      for (const t of targets) {
        const text = collectInbox(mailbox, t.id);
        if (text) {
          console.log(`===== ${t.label} =====`);
          console.log(text);
          console.log('');
          got = true;
        }
      }
      if (got) {
        cleanup();
        return; // a message arrived — hand control back so the agent acts + replies, then monitors again
      }
      if (Date.now() >= deadline) {
        cleanup();
        console.log('monitor: nothing arrived in the window — run `anyd monitor` again to keep waiting.');
        return;
      }
      await sleep(pollMs);
    }
  });
program
  .command('reply')
  .description('Reply to a message thread')
  .argument('<messageId>', 'message id (or unique prefix) to reply to')
  .argument('<message>', 'reply text')
  .action((messageId: string, message: string) => {
    const mailbox = openMailbox();
    const all = mailbox.inbox({ all: true });
    const hits = all.filter((m) => m.id.startsWith(messageId));
    const target = hits.length === 1 && hits[0] ? hits[0].id : messageId;
    const r = mailbox.reply(target, message);
    console.log(`queued reply ${r.id} → @${r.to.agent}:${r.to.sessionId.slice(0, 8)}`);
  });
program
  .command('conversations')
  .description('List established session-to-session conversations')
  .option('--json', 'output as JSON')
  .action((opts: { json?: boolean }) => {
    const convos = openMailbox().listConversations();
    if (opts.json) {
      console.log(JSON.stringify(convos, null, 2));
      return;
    }
    if (convos.length === 0) {
      console.log('no conversations yet — send a first message with anyd send');
      return;
    }
    for (const c of convos) {
      const last = c.lastMessage ? ` — ${c.lastMessage.parts[0]?.text.slice(0, 40) ?? ''}` : '';
      console.log(
        `@${c.a.agent}:${c.a.sessionId.slice(0, 8)} ↔ @${c.b.agent}:${c.b.sessionId.slice(0, 8)}  (${c.messageCount} msgs, ${formatRelativeTime(c.lastMessageAt)})${last}`,
      );
    }
  });

const collab = program
  .command('collab')
  .description('Shared collaboration doc for a conversation (Phase 4): one lead writes the plan, everyone appends progress');

collab
  .command('init')
  .description('Create the shared collaboration doc for a conversation (run by the lead)')
  .argument('[target]', 'the peer session, @<agent>[:<fragment>] (omit when using --conversation)')
  .requiredOption('--as <self>', 'your own session/label')
  .option('--conversation <id>', 'attach to an existing conversation id (e.g. a cross-device pair from anyd conversations)')
  .option('--lead <who>', 'who leads / owns the plan (defaults to you)')
  .option('--body <text>', 'initial plan / shared context (markdown)')
  .action(async (target: string | undefined, opts: { as: string; conversation?: string; lead?: string; body?: string }) => {
    let conversationId: string;
    let selfLabel: string;
    let peerLabel: string;
    let leadLabel: string;
    if (opts.conversation) {
      // Cross-device / explicit: labels are literal (no local scan needed — the
      // remote peer's session isn't in this machine's directory anyway).
      conversationId = opts.conversation;
      selfLabel = normalizeLabel(opts.as);
      peerLabel = target ? normalizeLabel(target) : '(the other party)';
      leadLabel = opts.lead ? normalizeLabel(opts.lead) : selfLabel;
    } else {
      if (!target) {
        console.error('error: give a <target>, or use --conversation <id> for a cross-device pair');
        process.exit(1);
      }
      const self = await resolveOrExit(opts.as);
      const peer = await resolveOrExit(target);
      conversationId = openMailbox().getOrCreateConversation(
        { agent: self.agent, sessionId: self.sessionId },
        { agent: peer.agent, sessionId: peer.sessionId },
      );
      selfLabel = `@${self.agent}:${self.title}`;
      peerLabel = `@${peer.agent}:${peer.title}`;
      leadLabel = selfLabel;
      if (opts.lead) {
        const l = await resolveOrExit(opts.lead);
        leadLabel = `@${l.agent}:${l.title}`;
      }
    }
    const store = createCollabStore();
    const preexisting = store.exists(conversationId);
    const doc = await store.ensure({
      conversationId,
      lead: leadLabel,
      ...(opts.body ? { body: opts.body } : {}),
    });
    console.log(`collab doc: ${store.path(conversationId)}`);
    console.log(`  conversationId: ${conversationId}`);
    console.log(`  lead: ${doc.lead}`);
    console.log(`  peers: ${selfLabel} ↔ ${peerLabel}`);
    if (preexisting) console.log(`  (doc already existed — left as-is; use anyd collab plan/task to change it)`);
    console.log(`\nNext:`);
    console.log(`  ${leadLabel === selfLabel ? 'you (lead) set the plan' : 'the lead sets the plan'}: anyd collab plan ${conversationId} --as "${leadLabel}" --body "..."`);
    console.log(`  either side logs progress:  anyd collab progress ${conversationId} --as "<your label>" "<one line>"`);
    if (opts.conversation) console.log(`  push to the other device:   anyd collab sync ${conversationId} --to @<device>`);
    console.log(`  view it any time:            anyd collab show ${conversationId}`);
  });

collab
  .command('show')
  .description('Print a collaboration doc')
  .argument('<conversationId>', 'the conversation id (see anyd collab list / anyd conversations)')
  .option('--json', 'output the raw document as JSON')
  .action((conversationId: string, opts: { json?: boolean }) => {
    const store = createCollabStore();
    let doc: CollabDoc | null;
    try {
      doc = store.load(conversationId);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    if (!doc) {
      console.error(`no collab doc for "${conversationId}" — create one with anyd collab init`);
      process.exit(1);
    }
    if (opts.json) {
      console.log(JSON.stringify(doc, null, 2));
      return;
    }
    printCollabDoc(doc);
  });

collab
  .command('list')
  .description('List all collaboration docs on this machine')
  .action(() => {
    const docs = createCollabStore().list();
    if (docs.length === 0) {
      console.log('no collab docs yet — start one with anyd collab init');
      return;
    }
    for (const d of docs) {
      const open = d.tasks.filter((t) => t.state !== 'done' && t.state !== 'failed').length;
      console.log(`${d.conversationId}  lead ${d.lead}  (${d.tasks.length} tasks, ${open} open)  ${d.updated}`);
    }
  });

collab
  .command('plan')
  .description('Set the plan / shared context (lead only)')
  .argument('<conversationId>', 'the conversation id')
  .requiredOption('--as <self>', 'your label — must be the lead')
  .option('--body <text>', 'plan markdown; omit to read from stdin')
  .action(async (conversationId: string, opts: { as: string; body?: string }) => {
    const body = opts.body ?? (await readStdin());
    try {
      await createCollabStore().setBody(conversationId, normalizeLabel(opts.as), body);
      console.log(`plan updated for ${conversationId}`);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

collab
  .command('task')
  .description('Add or update a task (lead only)')
  .argument('<conversationId>', 'the conversation id')
  .requiredOption('--as <self>', 'your label — must be the lead')
  .requiredOption('--id <id>', 'task id, e.g. t1')
  .requiredOption('--owner <who>', 'agent label that owns the task')
  .requiredOption('--state <state>', `one of: ${TASK_STATES.join(', ')}`)
  .option('--step <n/m>', 'progress by product, e.g. 2/4')
  .option('--note <text>', 'free note (e.g. what a blocked task waits on)')
  .action(async (conversationId: string, opts: { as: string; id: string; owner: string; state: string; step?: string; note?: string }) => {
    if (!TASK_STATES.includes(opts.state as TaskState)) {
      console.error(`error: invalid state "${opts.state}" — use one of: ${TASK_STATES.join(', ')}`);
      process.exit(1);
    }
    const task: CollabTask = {
      id: opts.id,
      owner: normalizeLabel(opts.owner),
      state: opts.state as TaskState,
      updated: new Date().toISOString(),
      ...(opts.step ? { step: opts.step } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    };
    try {
      await createCollabStore().upsertTask(conversationId, normalizeLabel(opts.as), task);
      console.log(`task ${opts.id} → ${opts.state}${opts.step ? ` (${opts.step})` : ''}`);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

collab
  .command('progress')
  .description('Append one line to YOUR progress section (any agent)')
  .argument('<conversationId>', 'the conversation id')
  .argument('<text>', 'one-line progress note (what you did + next step)')
  .requiredOption('--as <self>', 'your label')
  .action(async (conversationId: string, text: string, opts: { as: string }) => {
    try {
      await createCollabStore().appendProgress(conversationId, normalizeLabel(opts.as), text);
      console.log(`progress logged for ${normalizeLabel(opts.as)}`);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

collab
  .command('lead')
  .description('Hand the lead role to another agent (current lead only)')
  .argument('<conversationId>', 'the conversation id')
  .argument('<newLead>', 'label of the agent to become lead')
  .requiredOption('--as <self>', 'your label — must be the current lead')
  .action(async (conversationId: string, newLead: string, opts: { as: string }) => {
    try {
      await createCollabStore().setLead(conversationId, normalizeLabel(opts.as), normalizeLabel(newLead));
      console.log(`lead handed to ${normalizeLabel(newLead)}`);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

collab
  .command('sync')
  .description('Push this doc to a paired device, which merges it (M3 cross-device sync)')
  .argument('<conversationId>', 'the conversation id (same id on both devices)')
  .requiredOption('--to <device>', 'peer device to push to, e.g. @mini or mini')
  .option('--port <port>', 'local daemon port (used to discover the peer)', '7433')
  .action(async (conversationId: string, opts: { to: string; port: string }) => {
    const doc = createCollabStore().load(conversationId);
    if (!doc) {
      console.error(`no collab doc for "${conversationId}" — nothing to sync`);
      process.exit(1);
    }
    const device = opts.to.replace(/^@/, '').toLowerCase();
    interface PeerRow { device: string; host: string; port: number; }
    let peers: PeerRow[];
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/peers`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { lan: boolean; peers: PeerRow[] };
      if (!body.lan) {
        console.error('LAN peering is disabled on this daemon (--no-lan) — cannot sync');
        process.exit(1);
      }
      peers = body.peers;
    } catch {
      console.error('cannot reach the local daemon to find the peer — is anyd start running?');
      process.exit(1);
    }
    const peer = peers.find((p) => p.device.toLowerCase() === device);
    if (!peer) {
      console.error(`peer "@${device}" not found on the LAN (anyd peers to list). Is its daemon running and paired?`);
      process.exit(1);
    }
    const { pushCollabDoc } = await import('./cluster/peers.js');
    const { loadOrCreateToken } = await import('./cluster/token.js');
    const r = await pushCollabDoc(peer, serializeCollab(doc), loadOrCreateToken());
    if (r.ok) {
      console.log(`synced ${conversationId} → @${peer.device} (it merged your copy)`);
    } else {
      console.error(`sync failed: ${r.error}`);
      process.exit(1);
    }
  });

program.parse();
