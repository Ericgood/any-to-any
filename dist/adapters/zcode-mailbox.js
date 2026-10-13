import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** ZCode's own session-id guard — anything else would escape the mailbox root. */
const SESSION_RE = /^sess_[A-Za-z0-9._-]+$/;
const BUSY_STALE_MS = 30 * 60_000;
const TURN_START_MS = 60_000;
export function mailboxRoot(env = process.env, home = homedir()) {
    const raw = env['ZCODE_MAILBOX_ROOT'] ?? '~/.zcode/mailbox';
    return raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
}
function sessionDir(root, sessionId) {
    if (!SESSION_RE.test(sessionId) || sessionId.includes('..')) {
        throw new Error(`invalid ZCode session id for the mailbox: ${sessionId}`);
    }
    return join(root, sessionId);
}
/**
 * A flagged runtime `mkdir -p`s the session's unread/ on every drain (each turn
 * starts with one), so its existence is ZCode's own trace that this session runs
 * with the mailbox on. We can't ask the process: ZCode renames itself to
 * `zcode-cli`, which overwrites the memory `ps eww` would read its env from.
 */
export function mailboxEnabledFor(root, sessionId) {
    try {
        return existsSync(join(sessionDir(root, sessionId), 'unread'));
    }
    catch {
        return false;
    }
}
/** Write a version-1 envelope into unread/ atomically; returns its path. */
export function postToMailbox(root, envelope) {
    const dir = sessionDir(root, envelope.toSessionId);
    const unread = join(dir, 'unread');
    mkdirSync(unread, { recursive: true });
    const safeId = envelope.messageId.replace(/[^A-Za-z0-9._-]/g, '_');
    const name = `${Date.now()}-${safeId}.json`;
    // temp file outside unread/, then rename: the drain never sees a half-written file
    const temp = join(dir, `.anytoany-${name}.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, ...envelope }), { mode: 0o600 });
    const target = join(unread, name);
    renameSync(temp, target);
    return target;
}
/**
 * Take an undrained letter back. rename is atomic, so exactly one side wins:
 * true = we have it (deliver another way), false = ZCode already took it.
 */
export function reclaimMail(path) {
    const taken = `${path}.reclaimed`;
    try {
        renameSync(path, taken);
    }
    catch {
        return false;
    }
    rmSync(taken, { force: true });
    return true;
}
/**
 * Is the session in the middle of a turn? ZCode (opencode lineage) writes the
 * assistant message when a turn starts and stamps `time.completed` when it ends —
 * verified live: absent throughout a `sleep 20` turn, present after.
 */
export function isSessionBusy(dbFile, sessionId, now = Date.now()) {
    let db;
    try {
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
    }
    catch {
        return false;
    }
    try {
        const row = db
            .prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT 1')
            .get(sessionId);
        if (!row || typeof row.data !== 'string')
            return false;
        const data = JSON.parse(row.data);
        const age = now - (data.time?.created ?? 0);
        if (data.role === 'assistant')
            return !data.time?.completed && age < BUSY_STALE_MS;
        return data.role === 'user' && age < TURN_START_MS;
    }
    catch {
        return false; // schema drift — fall back to the classic path
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=zcode-mailbox.js.map