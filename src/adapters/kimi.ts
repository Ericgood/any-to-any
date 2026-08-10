import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

const TITLE_MAX = 80;
/** Kimi Code ships a single self-contained binary here after install. */
const HOME_BIN = join(homedir(), '.kimi-code', 'bin', 'kimi');

interface KimiAdapterOptions {
  indexFile?: string;
  kimiBin?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
}

interface IndexRow {
  sessionId?: unknown;
  workDir?: unknown;
  sessionDir?: unknown;
}

function defaultIndexFile(): string {
  return join(homedir(), '.kimi-code', 'session_index.jsonl');
}

function resolveKimi(): string | null {
  const env = process.env.ANYTOANY_KIMI_BIN;
  if (env && existsSync(env)) return env;
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (d && existsSync(join(d, 'kimi'))) return join(d, 'kimi');
  }
  if (existsSync(HOME_BIN)) return HOME_BIN;
  return null;
}

/**
 * Pull the agent's reply out of kimi's --output-format stream-json. Each line is
 * a JSON message; only assistant `content` is the agent's prose (which carries
 * the anytoany reply marker). `tool` results and the trailing `meta`
 * session.resume_hint must be excluded or they pollute reply extraction.
 */
function assistantText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t) as { role?: string; content?: unknown };
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
        parts.push(msg.content);
      }
    } catch {
      // non-JSON noise (banners) — ignore
    }
  }
  return parts.join('\n');
}

export function createKimiAdapter(options: KimiAdapterOptions = {}): DeliveryAdapter {
  const indexFile = options.indexFile ?? defaultIndexFile();
  const exec = options.exec ?? realExec;
  const timeoutMs = options.deliverTimeoutMs ?? 300_000;

  return {
    agent: 'kimi',

    // Verified on kimi 0.32.0: `kimi -S <id> -p <text>` resumes headless and
    // carries full history. `-p` CANNOT combine with -y/--yolo/--auto/--plan
    // (the CLI rejects it), and default -p already executes tools — so no
    // escalation flag is needed or possible here.
    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      const bin = options.kimiBin ?? resolveKimi();
      if (!bin) {
        return { ok: false, error: 'kimi not found — install Kimi Code or set ANYTOANY_KIMI_BIN' };
      }
      const args = ['-S', session.sessionId, '-p', envelope, '--output-format', 'stream-json'];
      const { stdout, stderr, code } = await exec(
        bin,
        args,
        session.cwd ? { cwd: session.cwd, timeoutMs } : { timeoutMs },
      );
      if (code !== 0) {
        return { ok: false, error: `kimi resume exited ${code}: …${stderr.slice(-500)}` };
      }
      return { ok: true, output: assistantText(stdout) };
    },

    async listSessions(): Promise<SessionInfo[]> {
      let raw: string;
      try {
        raw = readFileSync(indexFile, 'utf8');
      } catch {
        return []; // kimi not installed / no sessions yet
      }
      const byId = new Map<string, SessionInfo>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let row: IndexRow;
        try {
          row = JSON.parse(line) as IndexRow;
        } catch {
          continue; // skip malformed index lines
        }
        if (typeof row.sessionId !== 'string' || !row.sessionId) continue;
        const cwd = typeof row.workDir === 'string' ? row.workDir : '';
        const title = (basename(cwd) || 'untitled').slice(0, TITLE_MAX);
        let mtimeMs = 0;
        if (typeof row.sessionDir === 'string') {
          try {
            mtimeMs = (await stat(row.sessionDir)).mtimeMs;
          } catch {
            /* dir gone — keep 0 */
          }
        }
        byId.set(row.sessionId, { agent: 'kimi', sessionId: row.sessionId, title, cwd, lastActiveAt: mtimeMs });
      }
      return [...byId.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    },
  };
}
