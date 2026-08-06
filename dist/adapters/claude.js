import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { realExec } from './exec.js';
const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
/** Max bytes read per session file; large transcripts are sampled head + tail. */
const CHUNK = 256 * 1024;
const TITLE_MAX = 80;
/** System-wrapped user turns (command caveats etc.) are not usable as titles. */
const NON_TITLE_PREFIXES = ['<local-command-caveat>', 'Caveat:', '<command-name>', '<system-reminder>'];
function usableTitle(text) {
    const t = text.trim();
    if (!t || NON_TITLE_PREFIXES.some((p) => t.startsWith(p)))
        return undefined;
    return t;
}
function extractUserText(line) {
    const content = line.message?.content;
    if (typeof content === 'string')
        return usableTitle(content);
    if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'object' &&
                part !== null &&
                part.type === 'text' &&
                typeof part.text === 'string') {
                const usable = usableTitle(part.text);
                if (usable)
                    return usable;
            }
        }
    }
    return undefined;
}
function parseLines(raw) {
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // truncated sample boundaries and corrupt lines are expected — skip
        }
    }
    return out;
}
async function sampleFile(path, size) {
    if (size <= CHUNK * 2)
        return readFile(path, 'utf8');
    const fd = await import('node:fs/promises').then((m) => m.open(path, 'r'));
    try {
        const head = Buffer.alloc(CHUNK);
        const tail = Buffer.alloc(CHUNK);
        await fd.read(head, 0, CHUNK, 0);
        await fd.read(tail, 0, CHUNK, size - CHUNK);
        return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
    }
    finally {
        await fd.close();
    }
}
async function readSession(path, mtimeMs, size) {
    const lines = parseLines(await sampleFile(path, size));
    if (lines.length === 0)
        return null;
    let cwd = '';
    let lastCustomTitle;
    let firstUserText;
    for (const line of lines) {
        if (!cwd && typeof line.cwd === 'string')
            cwd = line.cwd;
        if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
            lastCustomTitle = line.customTitle;
        }
        if (firstUserText === undefined && line.type === 'user') {
            const text = extractUserText(line);
            if (text !== undefined)
                firstUserText = text;
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
export function createClaudeAdapter(options = {}) {
    const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
    const exec = options.exec ?? realExec;
    const timeoutMs = options.deliverTimeoutMs ?? 300_000;
    return {
        agent: 'claude',
        // Verified 2026-08-05: -p --resume keeps the session id stable but REQUIRES
        // running from the session's project cwd (spec §9 R1). Needs CLI login —
        // fails cleanly with "Not logged in" until the user runs claude /login once.
        async deliver(session, envelope) {
            if (!session.cwd) {
                return { ok: false, error: 'claude delivery requires the session cwd (unknown for this session)' };
            }
            const { stdout, stderr, code } = await exec('claude', ['-p', '--resume', session.sessionId, envelope], {
                cwd: session.cwd,
                timeoutMs,
            });
            if (code !== 0) {
                return { ok: false, error: `claude -p --resume exited ${code}: …${stderr.slice(-500)}` };
            }
            if (stdout.includes('Not logged in')) {
                return { ok: false, error: 'claude CLI not logged in (run `claude` once to unlock auto-delivery, see ADR-008)' };
            }
            return { ok: true, output: stdout };
        },
        async listSessions() {
            let projectDirs;
            try {
                projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
                    .filter((e) => e.isDirectory())
                    .map((e) => join(projectsDir, e.name));
            }
            catch {
                return []; // claude not installed / no sessions yet
            }
            const sessions = [];
            for (const dir of projectDirs) {
                let files;
                try {
                    files = (await readdir(dir)).filter((f) => UUID_JSONL_RE.test(f));
                }
                catch {
                    continue;
                }
                for (const file of files) {
                    const path = join(dir, file);
                    try {
                        const st = await stat(path);
                        const info = await readSession(path, st.mtimeMs, st.size);
                        if (info)
                            sessions.push(info);
                    }
                    catch {
                        // unreadable session file — skip rather than fail the whole scan
                    }
                }
            }
            return sessions;
        },
    };
}
//# sourceMappingURL=claude.js.map