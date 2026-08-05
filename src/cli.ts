#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { createClaudeAdapter } from './adapters/claude.js';
import { createCodexAdapter } from './adapters/codex.js';
import { resolveTarget } from './directory/resolve.js';
import { listAllSessions } from './directory/scanner.js';
import { formatRelativeTime, shortenHome } from './format.js';
import { createDb } from './mailbox/db.js';
import { createMailbox, type Message, type SessionRef } from './mailbox/mailbox.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const defaultAdapters = () => [createClaudeAdapter(), createCodexAdapter()];
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
  .option('--peer <host:port...>', 'manually add peer daemons (skips mDNS discovery for them)')
  .action(async (opts: { interval: string; directoryTtl: string; port: string; web: boolean; lan: boolean; peer?: string[] }) => {
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
    writePid();
    process.on('exit', clearPid);

    const stale = mailbox.recoverStale();
    if (stale > 0) console.log(`recovered ${stale} message(s) stranded by a previous daemon run`);

    console.log(`anyd ${version} — daemon starting (poll ${opts.interval}ms)`);
    const initial = await directory();
    console.log(`directory: ${initial.length} sessions discovered`);

    let web: { notifyChange(): void; close(): void; port: number } | null = null;
    if (opts.web || lan) {
      const { startConsoleServer } = await import('./daemon/server.js');
      web = startConsoleServer({
        mailbox,
        directory,
        port,
        ...(lan
          ? { peering: { selfDevice: lan.selfDevice, token: lan.token, localDirectory } }
          : {}),
      });
      console.log(`web console: http://127.0.0.1:${web.port}`);
    }

    const { startDispatcher } = await import('./daemon/dispatcher.js');
    const running = startDispatcher(
      {
        mailbox,
        adapters: new Map(adapters.map((a) => [a.agent, a])),
        directory,
        ...(lan ? { selfDevice: lan.selfDevice, relay: lan.relay } : {}),
        onEvent: (e) => {
          const m = e.message;
          const line = `[${new Date().toISOString()}] ${e.kind} ${m.id.slice(0, 8)} @${m.from.agent} → @${m.to.device ?? 'local'}/${m.to.agent}${e.detail ? ` — ${e.detail}` : ''}`;
          console.log(line);
          web?.notifyChange();
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
    const pid = readPid();
    if (!pid) {
      console.log('daemon not running (no pid file)');
      return;
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
  .description('List LAN peers discovered via mDNS (requires running daemon on both ends)')
  .action(async () => {
    const { loadOrCreateToken, tokenFingerprint } = await import('./cluster/token.js');
    const { getDeviceName } = await import('./cluster/device.js');
    const { startPeerRegistry } = await import('./cluster/peers.js');
    const fp = tokenFingerprint(loadOrCreateToken());
    const registry = startPeerRegistry({ selfDevice: getDeviceName(), port: 0, token: loadOrCreateToken() });
    console.log('browsing mDNS for 3s…');
    await new Promise((r) => setTimeout(r, 3000));
    const peers = registry.list();
    registry.stop();
    if (peers.length === 0) {
      console.log('no peers found (is anyd start running on the other device? same network?)');
      return;
    }
    for (const p of peers) {
      const paired = p.fp === fp ? 'paired' : 'NOT paired (different token — run anyd pair)';
      console.log(`@${p.device}  ${p.host}:${p.port}  ${paired}`);
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

program.parse();
