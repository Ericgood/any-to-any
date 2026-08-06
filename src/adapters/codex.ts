import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

const ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const FIRST_LINE_MAX = 1024 * 1024; // session_meta can carry long base_instructions
const TITLE_MAX = 80;

interface CodexAdapterOptions {
  sessionsDir?: string;
  indexFile?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** anytoany machine config (~/.anytoany/config.json) — sandbox opt-in. */
  configFile?: string;
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

  return {
    agent: 'codex',

    // Verified 2026-08-05: exec resume carries full history, is cwd-independent,
    // and tolerates concurrent resumes of the same thread (spec §9 R2).
    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      // Sandbox stays on codex's own default unless the MACHINE OWNER opted
      // into a specific policy (never the sending agent). We never use the
      // --dangerously-bypass-* flag; danger-full-access is a sandbox tier the
      // owner may pick for their own cluster.
      const sandbox = readMachineConfig(configFile).codex?.sandbox;
      const sandboxArgs = sandbox && CODEX_SANDBOX_MODES.has(sandbox) ? ['--sandbox', sandbox] : [];
      const { stdout, stderr, code } = await exec(
        'codex',
        ['exec', 'resume', session.sessionId, '--skip-git-repo-check', ...sandboxArgs, envelope],
        session.cwd ? { cwd: session.cwd, timeoutMs } : { timeoutMs },
      );
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

      const sessions: SessionInfo[] = [];
      for (const { rel, sessionId } of newestRollout.values()) {
        const path = join(sessionsDir, rel);
        try {
          const first = await readFirstLine(path);
          if (!first) continue;
          const meta = JSON.parse(first) as {
            type?: string;
            payload?: { cwd?: string; parent_thread_id?: string; thread_source?: string };
          };
          if (meta.type !== 'session_meta') continue;
          // multi-agent sub-agent threads reject direct input (app-server -32600) —
          // they are parent-driven and must not be addressable
          if (meta.payload?.parent_thread_id || meta.payload?.thread_source === 'subagent') continue;
          const cwd = typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : '';
          const idx = index.get(sessionId);
          const title = (idx?.threadName ?? basename(cwd) ?? '').trim() || 'untitled';
          const st = await stat(path);
          // index updated_at can be weeks stale (the desktop app doesn't bump it);
          // the rollout file mtime moves on every turn — trust whichever is newer
          sessions.push({
            agent: 'codex',
            sessionId,
            title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
            cwd,
            lastActiveAt: Math.max(idx?.updatedAtMs ?? 0, st.mtimeMs),
          });
        } catch {
          // unreadable rollout — skip rather than fail the whole scan
        }
      }
      return sessions;
    },
  };
}
