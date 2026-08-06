import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { anytoanyHome } from '../home.js';
import { realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

const TITLE_MAX = 80;
/** The desktop app bundles the full CLI engine — no separate install needed. */
const APP_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

interface ZcodeAdapterOptions {
  dbFile?: string;
  engineBin?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** anytoany machine config (~/.anytoany/config.json) — delivery mode opt-in. */
  configFile?: string;
}

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
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as {
      zcode?: { deliverMode?: string };
    };
    const mode = raw.zcode?.deliverMode;
    if (mode && ZCODE_MODES.has(mode)) return mode;
  } catch {
    /* no config or unreadable — stay on the safe default */
  }
  return 'build';
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
  const timeoutMs = options.deliverTimeoutMs ?? 300_000;
  const configFile = options.configFile ?? join(anytoanyHome(), '.anytoany', 'config.json');

  return {
    agent: 'zcode',

    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      const engine = options.engineBin ?? resolveEngine();
      if (!engine) {
        return {
          ok: false,
          error: 'zcode engine not found — install the ZCode desktop app or set ANYTOANY_ZCODE_BIN',
        };
      }
      const args = [
        ...(session.cwd ? ['--cwd', session.cwd] : []),
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
        session.cwd ? { cwd: session.cwd, timeoutMs } : { timeoutMs },
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
