import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentAdapter, SessionInfo } from './types.js';

const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** Max bytes read per session file; large transcripts are sampled head + tail. */
const CHUNK = 256 * 1024;
const TITLE_MAX = 80;

interface ClaudeAdapterOptions {
  projectsDir?: string;
}

interface ParsedLine {
  type?: string;
  cwd?: string;
  customTitle?: string;
  message?: { content?: unknown };
}

function extractUserText(line: ParsedLine): string | undefined {
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return undefined;
}

function parseLines(raw: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ParsedLine);
    } catch {
      // truncated sample boundaries and corrupt lines are expected — skip
    }
  }
  return out;
}

async function sampleFile(path: string, size: number): Promise<string> {
  if (size <= CHUNK * 2) return readFile(path, 'utf8');
  const fd = await import('node:fs/promises').then((m) => m.open(path, 'r'));
  try {
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await fd.read(head, 0, CHUNK, 0);
    await fd.read(tail, 0, CHUNK, size - CHUNK);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    await fd.close();
  }
}

async function readSession(path: string, mtimeMs: number, size: number): Promise<SessionInfo | null> {
  const lines = parseLines(await sampleFile(path, size));
  if (lines.length === 0) return null;

  let cwd = '';
  let lastCustomTitle: string | undefined;
  let firstUserText: string | undefined;
  for (const line of lines) {
    if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;
    if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
      lastCustomTitle = line.customTitle;
    }
    if (firstUserText === undefined && line.type === 'user') {
      firstUserText = extractUserText(line);
    }
  }

  const title = (lastCustomTitle ?? firstUserText ?? basename(cwd) ?? '').trim() || 'untitled';
  return {
    agent: 'claude',
    sessionId: basename(path, '.jsonl'),
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
    cwd,
    lastActiveAt: mtimeMs,
  };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');

  return {
    agent: 'claude',
    async listSessions(): Promise<SessionInfo[]> {
      let projectDirs: string[];
      try {
        projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => join(projectsDir, e.name));
      } catch {
        return []; // claude not installed / no sessions yet
      }

      const sessions: SessionInfo[] = [];
      for (const dir of projectDirs) {
        let files: string[];
        try {
          files = (await readdir(dir)).filter((f) => UUID_JSONL_RE.test(f));
        } catch {
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          try {
            const st = await stat(path);
            const info = await readSession(path, st.mtimeMs, st.size);
            if (info) sessions.push(info);
          } catch {
            // unreadable session file — skip rather than fail the whole scan
          }
        }
      }
      return sessions;
    },
  };
}
