import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { liveCodexThreads } from '../daemon/session-liveness.js';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { realExec } from './exec.js';
import { checkCliVersion, createVersionProbe, inferWriterVersion, type WriterSample } from './version-guard.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

const CODEX_GUARD = { cli: 'codex', app: 'Codex Desktop', upgrade: 'npm i -g @openai/codex@latest' };

/** Error-code prefix for a thread another Codex process is writing to (ADR-026). */
export const THREAD_BUSY = 'codex_thread_busy';
const ACTIVE_WRITER = /already has an active writer/;

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/** Owner-configured per-turn budget (heavy tasks outgrow the 300s default). */
function loadCodexTimeoutMs(configFile: string): number | null {
  const sec = readMachineConfig(configFile).codex?.deliverTimeoutSec;
  return typeof sec === 'number' && sec >= 60 && sec <= 3600 ? sec * 1000 : null;
}

const ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** `codex queue` only appends a row; it should return in seconds. */
const QUEUE_TIMEOUT_MS = 30_000;

const FIRST_LINE_MAX = 1024 * 1024; // session_meta can carry long base_instructions
const TITLE_MAX = 80;

interface CodexAdapterOptions {
  sessionsDir?: string;
  indexFile?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** anytoany machine config (~/.anytoany/config.json) — sandbox opt-in. */
  configFile?: string;
  /** Is the thread held open by another Codex process (Codex Desktop)? ADR-026/027. */
  isThreadLive?: (threadId: string) => boolean;
}

interface IndexEntry {
  threadName: string;
  updatedAtMs?: number;
}

/** Read up to the first newline without loading the whole rollout file. */
async function readFirstLine(path: string): Promise<string | null> {
  const fd = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < FIRST_LINE_MAX) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      total += bytesRead;
    }
    return total > 0 ? Buffer.concat(chunks).toString('utf8') : null;
  } finally {
    await fd.close();
  }
}

async function loadIndex(indexFile: string): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>();
  let raw: string;
  try {
    raw = await readFile(indexFile, 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      if (!rec.id || typeof rec.thread_name !== 'string') continue;
      const entry: IndexEntry = { threadName: rec.thread_name };
      const ts = rec.updated_at ? Date.parse(rec.updated_at) : NaN;
      if (!Number.isNaN(ts)) entry.updatedAtMs = ts;
      map.set(rec.id, entry); // later lines win — index is append-mostly
    } catch {
      // skip corrupt index lines
    }
  }
  return map;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): DeliveryAdapter {
  const sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
  const indexFile = options.indexFile ?? join(homedir(), '.codex', 'session_index.jsonl');
  const exec = options.exec ?? realExec;
  const timeoutMs = options.deliverTimeoutMs ?? 300_000;
  const configFile = options.configFile ?? defaultConfigFile();
  const isThreadLive = options.isThreadLive ?? ((id: string) => liveCodexThreads().has(id));
  const probeVersion = createVersionProbe(exec, 'codex');
  // The queue path only appends a row to Codex's own queue — no resume, so the
  // CLI-older-than-App hazard doesn't apply (verified 0.157.1 → 0.162-alpha). ADR-027.
  const preflight = async (session: SessionInfo) =>
    isThreadLive(session.sessionId) ? null : checkCliVersion(probeVersion, CODEX_GUARD, session.writerVersion);

  /**
   * A thread Codex Desktop holds open refuses `exec resume` (active writer), but
   * Desktop watches the shared queue (~/.codex/queue_1.sqlite) for the threads it
   * has loaded and runs a queued message within seconds — verified 2026-10-13 on a
   * throwaway thread (ADR-027). There's no stdout to read, so replies come back
   * through `anyd reply` (see replyChannel).
   */
  async function deliverViaQueue(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
    const { stdout, stderr, code } = await exec(
      'codex',
      ['queue', '--thread', session.sessionId, '--message', envelope],
      session.cwd ? { cwd: session.cwd, timeoutMs: QUEUE_TIMEOUT_MS } : { timeoutMs: QUEUE_TIMEOUT_MS },
    );
    if (code !== 0) {
      return { ok: false, error: `codex queue exited ${code}: …${(stderr || stdout).slice(-500)}` };
    }
    return { ok: true, output: '', inSession: true };
  }

  return {
    agent: 'codex',
    preflight,
    replyChannel: (session: SessionInfo) => (isThreadLive(session.sessionId) ? 'command' : 'marker'),

    // Verified 2026-08-05: exec resume carries full history, is cwd-independent,
    // and tolerates concurrent resumes of the same thread (spec §9 R2).
    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      if (isThreadLive(session.sessionId)) return deliverViaQueue(session, envelope);
      // An older CLI can't resume what a newer Codex Desktop wrote — refuse loudly (ADR-025).
      const mismatch = await preflight(session);
      if (mismatch) return { ok: false, retry: false, error: mismatch };
      // Sandbox stays on codex's own default unless the MACHINE OWNER opted
      // into a specific policy (never the sending agent). We never use the
      // --dangerously-bypass-* flag; danger-full-access is a sandbox tier the
      // owner may pick for their own cluster.
      const sandbox = readMachineConfig(configFile).codex?.sandbox;
      const sandboxArgs = sandbox && CODEX_SANDBOX_MODES.has(sandbox) ? ['--sandbox', sandbox] : [];
      // read per delivery so config edits apply without a daemon restart
      const turnTimeoutMs = options.deliverTimeoutMs ?? loadCodexTimeoutMs(configFile) ?? timeoutMs;
      // --sandbox is an `exec` option, NOT a `resume` one — it must sit between
      // `exec` and the `resume` subcommand, or the CLI rejects it (exit 2,
      // "unexpected argument '--sandbox'") and every delivery fails.
      const { stdout, stderr, code } = await exec(
        'codex',
        ['exec', ...sandboxArgs, 'resume', session.sessionId, '--skip-git-repo-check', envelope],
        session.cwd ? { cwd: session.cwd, timeoutMs: turnTimeoutMs } : { timeoutMs: turnTimeoutMs },
      );
      if (code === 124) {
        // timeout: the turn DID run on the target and was killed mid-work — retrying
        // just re-runs (and duplicates) the same heavy turn. Terminal, not retryable.
        return {
          ok: false,
          retry: false,
          error: `codex exec resume timed out after ${Math.round(turnTimeoutMs / 1000)}s — the turn ran but exceeded the budget. Raise codex.deliverTimeoutSec in ~/.anytoany/config.json, or open the session to see its progress. …${stderr.slice(-300)}`,
        };
      }
      if (code !== 0 && ACTIVE_WRITER.test(stderr)) {
        // The thread is open in another Codex process (Codex Desktop) holding its
        // writer lock. Normally the dispatcher skips such threads (ADR-026); this is
        // the race / no-lsof fallback. The turn never ran, and the holder is a
        // long-lived App, so retrying in seconds would only hit the same lock.
        return {
          ok: false,
          retry: false,
          error: `${THREAD_BUSY}: codex thread ${session.sessionId} is open in another Codex process (usually Codex Desktop), which holds its writer lock — headless resume was refused and the message was NOT delivered. It will surface through the thread's prompt hook the next time the user sends it a message.`,
        };
      }
      if (code !== 0) {
        // the actual error is at the END of stderr (after the banner + prompt echo)
        return { ok: false, error: `codex exec resume exited ${code}: …${stderr.slice(-500)}` };
      }
      return { ok: true, output: stdout };
    },
    async listSessions(): Promise<SessionInfo[]> {
      let entries: string[];
      try {
        entries = (await readdir(sessionsDir, { recursive: true })) as string[];
      } catch {
        return []; // codex not installed / no sessions yet
      }
      const index = await loadIndex(indexFile);

      // A thread can span several rollout files (new day, app compaction).
      // `codex exec resume` reads the NEWEST one — so that is the file that
      // must pass the health check, and each thread must appear only once.
      const newestRollout = new Map<string, { rel: string; sessionId: string }>();
      for (const rel of entries) {
        const name = basename(rel);
        const m = ROLLOUT_RE.exec(name);
        if (!m || !m[1]) continue;
        const prev = newestRollout.get(m[1]);
        if (!prev || basename(prev.rel).localeCompare(name) < 0) {
          newestRollout.set(m[1], { rel, sessionId: m[1] });
        }
      }

      const found: Array<{ info: SessionInfo; own?: string; originator?: string }> = [];
      const samples: WriterSample[] = [];
      for (const { rel, sessionId } of newestRollout.values()) {
        const path = join(sessionsDir, rel);
        try {
          const first = await readFirstLine(path);
          if (!first) continue;
          const meta = JSON.parse(first) as {
            type?: string;
            payload?: {
              cwd?: string;
              parent_thread_id?: string;
              thread_source?: string;
              cli_version?: string;
              originator?: string;
              timestamp?: string;
            };
          };
          if (meta.type !== 'session_meta') continue;
          const own = typeof meta.payload?.cli_version === 'string' ? meta.payload.cli_version : undefined;
          const originator = typeof meta.payload?.originator === 'string' ? meta.payload.originator : undefined;
          const createdAt = meta.payload?.timestamp ? Date.parse(meta.payload.timestamp) : NaN;
          // every rollout's creation is a sighting of its originator's version (ADR-025)
          if (own && originator && !Number.isNaN(createdAt)) samples.push({ originator, version: own, at: createdAt });
          // multi-agent sub-agent threads reject direct input (app-server -32600) —
          // they are parent-driven and must not be addressable
          if (meta.payload?.parent_thread_id || meta.payload?.thread_source === 'subagent') continue;
          const cwd = typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : '';
          const idx = index.get(sessionId);
          const title = (idx?.threadName ?? basename(cwd) ?? '').trim() || 'untitled';
          const st = await stat(path);
          // index updated_at can be weeks stale (the desktop app doesn't bump it);
          // the rollout file mtime moves on every turn — trust whichever is newer
          found.push({
            info: {
              agent: 'codex',
              sessionId,
              title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
              cwd,
              lastActiveAt: Math.max(idx?.updatedAtMs ?? 0, st.mtimeMs),
            },
            ...(own ? { own } : {}),
            ...(originator ? { originator } : {}),
          });
        } catch {
          // unreadable rollout — skip rather than fail the whole scan
        }
      }
      // cli_version is recorded once, at thread creation; the live writer of an old
      // thread is whatever its originator runs now — infer it across all rollouts
      return found.map(({ info, own, originator }) => {
        const writerVersion = inferWriterVersion(own, originator, info.lastActiveAt, samples);
        return writerVersion ? { ...info, writerVersion } : info;
      });
    },
  };
}
