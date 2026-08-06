import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { realExec } from './exec.js';
const TITLE_MAX = 80;
/** The desktop app bundles the full CLI engine — no separate install needed. */
const APP_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const ZCODE_MODES = new Set(['plan', 'edit', 'build', 'yolo']);
/**
 * Delivery permission mode for headless zcode turns. Default 'build': safe,
 * but confirmation-gated tools are DENIED headless (no human to approve), so
 * the session is effectively read-only. The MACHINE OWNER may escalate via
 * ~/.anytoany/config.json → { "zcode": { "deliverMode": "yolo" } } — an
 * explicit local opt-in; never controlled by the sending agent. Read per
 * delivery so edits apply without a daemon restart.
 */
function loadDeliverMode(configFile) {
    const mode = readMachineConfig(configFile).zcode?.deliverMode;
    return mode && ZCODE_MODES.has(mode) ? mode : 'build';
}
/** Owner-configured per-turn budget (heavy tasks outgrow the 300s default). */
function loadDeliverTimeoutMs(configFile) {
    const sec = readMachineConfig(configFile).zcode?.deliverTimeoutSec;
    return typeof sec === 'number' && sec >= 60 && sec <= 3600 ? sec * 1000 : null;
}
function defaultDbFile() {
    // Fixed path on purpose: ZCODE_DATA_BASE_DIR in engine 0.15.2 only relocates
    // credentials, NOT this db (verified) — honoring it here would desync us.
    return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}
function resolveEngine() {
    const env = process.env.ANYTOANY_ZCODE_BIN;
    if (env && existsSync(env))
        return env;
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, 'zcode')))
            return join(dir, 'zcode');
    }
    if (existsSync(APP_ENGINE))
        return APP_ENGINE;
    return null;
}
export function createZcodeAdapter(options = {}) {
    const dbFile = options.dbFile ?? defaultDbFile();
    const exec = options.exec ?? realExec;
    const timeoutMs = options.deliverTimeoutMs ?? 300_000;
    const configFile = options.configFile ?? defaultConfigFile();
    return {
        agent: 'zcode',
        async deliver(session, envelope) {
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
            const turnTimeoutMs = options.deliverTimeoutMs ?? loadDeliverTimeoutMs(configFile) ?? timeoutMs;
            const { stdout, stderr, code } = await exec(viaNode ? 'node' : engine, viaNode ? [engine, ...args] : args, session.cwd ? { cwd: session.cwd, timeoutMs: turnTimeoutMs } : { timeoutMs: turnTimeoutMs });
            if (code !== 0) {
                return { ok: false, error: `zcode resume exited ${code}: …${stderr.slice(-500)}` };
            }
            return { ok: true, output: stdout };
        },
        async listSessions() {
            let db;
            try {
                // readonly: the desktop app keeps this WAL db open and writing
                db = new Database(dbFile, { readonly: true, fileMustExist: true });
            }
            catch {
                return []; // ZCode not installed on this machine
            }
            try {
                const rows = db.prepare('SELECT * FROM session').all();
                const sessions = [];
                for (const r of rows) {
                    if (typeof r.id !== 'string' || !r.id)
                        continue;
                    // sub-agent sessions are parent-driven and must not be addressable
                    if (r.id.startsWith('sess_subagent'))
                        continue;
                    if (typeof r.parent_id === 'string' && r.parent_id)
                        continue;
                    if (r.task_type === 'subagent_child')
                        continue;
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
            }
            catch {
                return []; // no session table / schema drift — treat as not installed
            }
            finally {
                db.close();
            }
        },
    };
}
//# sourceMappingURL=zcode.js.map