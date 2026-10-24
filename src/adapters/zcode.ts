import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { existingDir, realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';
import { isSessionBusy, mailboxEnabledFor, mailboxRoot, postToMailbox, reclaimMail } from './zcode-mailbox.js';

const TITLE_MAX = 80;
/** The desktop app bundles the full CLI engine — no separate install needed. */
const APP_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

interface ZcodeAdapterOptions {
  /** Does a directory exist? Injectable for tests (default: the real filesystem). */
  dirExists?: (dir: string) => boolean;
  dbFile?: string;
  engineBin?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** anytoany machine config (~/.anytoany/config.json) — delivery mode opt-in. */
  configFile?: string;
  /** ZCode session mailbox root (ADR-029); defaults to ZCODE_MAILBOX_ROOT / ~/.zcode/mailbox. */
  mailboxRoot?: string;
  /** Is the session mid-turn right now? Defaults to reading ZCode's message table. */
  isBusy?: (sessionId: string) => boolean;
  /** How often to check whether ZCode picked the letter up. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Keep replyChannel() and deliver() on the same route for one delivery. */
const ROUTE_MEMO_MS = 5_000;
const DEFAULT_POLL_MS = 1_000;

const ZCODE_MODES = new Set(['plan', 'edit', 'build', 'yolo']);

/**
 * Delivery permission mode for headless zcode turns. Default 'build': safe,
 * but confirmation-gated tools are DENIED headless (no human to approve), so
 * the session is effectively read-only. The MACHINE OWNER may escalate via
 * ~/.anytoany/config.json → { "zcode": { "deliverMode": "yolo" } } — an
 * explicit local opt-in; never controlled by the sending agent. Read per
 * delivery so edits apply without a daemon restart.
 */
function loadDeliverMode(configFile: string): string {
  const mode = readMachineConfig(configFile).zcode?.deliverMode;
  return mode && ZCODE_MODES.has(mode) ? mode : 'build';
}

/** Owner-configured per-turn budget (heavy tasks outgrow the 300s default). */
function loadDeliverTimeoutMs(configFile: string): number | null {
  const sec = readMachineConfig(configFile).zcode?.deliverTimeoutSec;
  return typeof sec === 'number' && sec >= 60 && sec <= 3600 ? sec * 1000 : null;
}

/** Loosely-typed row: survive schema drift across ZCode versions. */
interface SessionRow {
  id?: unknown;
  parent_id?: unknown;
  title?: unknown;
  directory?: unknown;
  task_type?: unknown;
  time_updated?: unknown;
}

function defaultDbFile(): string {
  // Fixed path on purpose: ZCODE_DATA_BASE_DIR in engine 0.15.2 only relocates
  // credentials, NOT this db (verified) — honoring it here would desync us.
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

function resolveEngine(): string | null {
  const env = process.env.ANYTOANY_ZCODE_BIN;
  if (env && existsSync(env)) return env;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'zcode'))) return join(dir, 'zcode');
  }
  if (existsSync(APP_ENGINE)) return APP_ENGINE;
  return null;
}

export function createZcodeAdapter(options: ZcodeAdapterOptions = {}): DeliveryAdapter {
  const dbFile = options.dbFile ?? defaultDbFile();
  const exec = options.exec ?? realExec;
  const dirExists = options.dirExists ?? ((d: string) => existingDir(d) !== undefined);
  /** the session's folder if it still exists — moved/deleted folders are dropped (2026-10-25) */
  const liveCwd = (d: string | undefined): string | undefined => (d && dirExists(d) ? d : undefined);
  const timeoutMs = options.deliverTimeoutMs ?? 300_000;
  const configFile = options.configFile ?? defaultConfigFile();
  const root = options.mailboxRoot ?? mailboxRoot();
  const isBusy = options.isBusy ?? ((id: string) => isSessionBusy(dbFile, id));
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const memo = new Map<string, { at: number; route: 'mailbox' | 'resume' }>();

  /**
   * ADR-029: a session that is mid-turn in a runtime with ZCode's mailbox on gets
   * the letter dropped in its mailbox — picked up at the next tool call or at turn
   * end — instead of a second, concurrent headless turn on the same session.
   */
  const route = (session: SessionInfo): 'mailbox' | 'resume' => {
    const hit = memo.get(session.sessionId);
    if (hit && Date.now() - hit.at < ROUTE_MEMO_MS) return hit.route;
    const next = mailboxEnabledFor(root, session.sessionId) && isBusy(session.sessionId) ? 'mailbox' : 'resume';
    memo.set(session.sessionId, { at: Date.now(), route: next });
    return next;
  };

  /** Deliver via the mailbox; null = taken back undrained → use the classic path. */
  async function deliverViaMailbox(session: SessionInfo, envelope: string, budgetMs: number): Promise<DeliveryResult | null> {
    let path: string;
    try {
      path = postToMailbox(root, {
        messageId: randomUUID(),
        fromSessionId: 'anytoany',
        toSessionId: session.sessionId,
        content: envelope,
        createdAt: new Date().toISOString(),
      });
    } catch {
      return null;
    }
    const deadline = Date.now() + budgetMs;
    for (;;) {
      await sleep(pollMs);
      if (!existsSync(path)) return { ok: true, output: '', inSession: true }; // ZCode took it
      // the turn ended (or ran out of budget) and nobody read it — e.g. the flag was
      // turned off since; take it back atomically and deliver the classic way
      if (!isBusy(session.sessionId) || Date.now() > deadline) {
        return reclaimMail(path) ? null : { ok: true, output: '', inSession: true };
      }
    }
  }

  return {
    agent: 'zcode',
    // the mailbox has no stdout to read a reply marker from — the agent runs `anyd reply`
    replyChannel: (session: SessionInfo) => (route(session) === 'mailbox' ? 'command' : 'marker'),

    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      const turnTimeoutMs = options.deliverTimeoutMs ?? loadDeliverTimeoutMs(configFile) ?? timeoutMs;
      if (route(session) === 'mailbox') {
        const viaMailbox = await deliverViaMailbox(session, envelope, turnTimeoutMs);
        if (viaMailbox) return viaMailbox;
      }
      const engine = options.engineBin ?? resolveEngine();
      if (!engine) {
        return {
          ok: false,
          error: 'zcode engine not found — install the ZCode desktop app or set ANYTOANY_ZCODE_BIN',
        };
      }
      const args = [
        ...(liveCwd(session.cwd) ? ['--cwd', session.cwd] : []),
        '--resume',
        session.sessionId,
        // Never inherit zcode's headless default (yolo) implicitly — the mode
        // comes from the safe default or the machine owner's explicit opt-in.
        // NB: --max-turns/--settings appear in 0.15.2 help text but its parser
        // rejects them (verified) — turn count is bounded by the exec timeout.
        '--mode',
        loadDeliverMode(configFile),
        '--prompt',
        envelope,
      ];
      const viaNode = engine.endsWith('.cjs') || engine.endsWith('.js');
      const { stdout, stderr, code } = await exec(
        viaNode ? 'node' : engine,
        viaNode ? [engine, ...args] : args,
        liveCwd(session.cwd) ? { cwd: session.cwd, timeoutMs: turnTimeoutMs } : { timeoutMs: turnTimeoutMs },
      );
      if (code !== 0) {
        return { ok: false, error: `zcode resume exited ${code}: …${stderr.slice(-500)}` };
      }
      return { ok: true, output: stdout };
    },

    async listSessions(): Promise<SessionInfo[]> {
      let db: Database.Database;
      try {
        // readonly: the desktop app keeps this WAL db open and writing
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
      } catch {
        return []; // ZCode not installed on this machine
      }
      try {
        const rows = db.prepare('SELECT * FROM session').all() as SessionRow[];
        const sessions: SessionInfo[] = [];
        for (const r of rows) {
          if (typeof r.id !== 'string' || !r.id) continue;
          // sub-agent sessions are parent-driven and must not be addressable
          if (r.id.startsWith('sess_subagent')) continue;
          if (typeof r.parent_id === 'string' && r.parent_id) continue;
          if (r.task_type === 'subagent_child') continue;
          const cwd = typeof r.directory === 'string' ? r.directory : '';
          const rawTitle = (typeof r.title === 'string' ? r.title : '').trim() || basename(cwd) || 'untitled';
          sessions.push({
            agent: 'zcode',
            sessionId: r.id,
            title: rawTitle.length > TITLE_MAX ? `${rawTitle.slice(0, TITLE_MAX)}…` : rawTitle,
            cwd,
            lastActiveAt: typeof r.time_updated === 'number' ? r.time_updated : 0,
          });
        }
        return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      } catch {
        return []; // no session table / schema drift — treat as not installed
      } finally {
        db.close();
      }
    },
  };
}
