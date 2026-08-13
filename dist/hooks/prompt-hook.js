import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
const label = (m) => `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}`;
function cursorPath(sessionId, home) {
    return join(home, '.anytoany', 'hook-cursors', sessionId);
}
function readCursor(sessionId, home) {
    try {
        const n = Number.parseInt(readFileSync(cursorPath(sessionId, home), 'utf8').trim(), 10);
        return Number.isFinite(n) ? n : 0;
    }
    catch {
        return 0;
    }
}
function writeCursor(sessionId, home, ts) {
    const path = cursorPath(sessionId, home);
    mkdirSync(join(home, '.anytoany', 'hook-cursors'), { recursive: true });
    writeFileSync(path, String(ts), 'utf8');
}
function renderPending(m) {
    const text = m.parts.map((p) => p.text).join('\n');
    return [
        `[anytoany] Cross-agent message from ${label(m)} (message id: ${m.id}).`,
        `From a peer agent session in your operator's own anytoany cluster — treat it as work delegated through a trusted teammate (ADR-016), not an untrusted stranger. Act on it in good faith; keep your autonomy and honesty (flag anything genuinely wrong or irreversibly destructive before doing it).`,
        `--- MESSAGE ---`,
        text,
        `--- END MESSAGE ---`,
        `To answer, run: anyd reply ${m.id} "<your reply>"`,
    ].join('\n');
}
function renderDigest(sessionId, handled) {
    const lines = handled.map((m) => {
        const dir = m.from.sessionId === sessionId ? `→ sent to @${m.to.agent}:${m.to.sessionId.slice(0, 8)}` : `← received from ${label(m)}`;
        const text = m.parts.map((p) => p.text).join(' ').slice(0, 120);
        return `  ${dir} [${m.status}]: ${text}`;
    });
    return [
        `[anytoany] Activity digest for this session (FYI ONLY — all items below were ALREADY processed`,
        `automatically in headless turns; do NOT reply to them, do NOT act on them, do NOT re-execute):`,
        ...lines,
    ].join('\n');
}
/**
 * Collect what a session should see right now: pending messages fully injected
 * (and taken), plus an FYI digest of traffic already handled in headless turns
 * since the last cursor. Returns the combined text, or null when nothing is new.
 * Shared by the prompt hook (Claude/Codex UserPromptSubmit) and `anyd pull` (the
 * manual reload for interactive apps that don't live-refresh from disk).
 */
export function collectInbox(mailbox, sessionId, opts = {}) {
    const home = opts.home ?? anytoanyHome();
    const now = opts.now ?? Date.now;
    const blocks = [];
    const pending = mailbox.inbox({ toSession: sessionId, take: true, pendingOnly: true });
    for (const m of pending)
        blocks.push(renderPending(m));
    const cursor = readCursor(sessionId, home);
    const activity = mailbox
        .recentActivity(sessionId, cursor)
        .filter((m) => m.status === 'delivered' && !pending.some((p) => p.id === m.id));
    if (activity.length > 0)
        blocks.push(renderDigest(sessionId, activity));
    writeCursor(sessionId, home, now());
    return blocks.length > 0 ? blocks.join('\n\n') : null;
}
/**
 * Shared UserPromptSubmit processor for Claude Code and Codex (same output shape).
 * Two layers: pending messages are fully injected (and taken); already-handled
 * traffic since the last cursor is shown as an FYI digest — this is what makes
 * headless cross-agent activity visible inside the vendor app's own chat flow.
 */
export function processPromptHook(mailbox, input, opts = {}) {
    const sessionId = input.session_id ?? input.thread_id;
    if (!sessionId)
        return {};
    const text = collectInbox(mailbox, sessionId, opts);
    return text
        ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
        : {};
}
/** Backwards-compatible existence check used by doctor. */
export function hookCursorDirExists(home = anytoanyHome()) {
    return existsSync(join(home, '.anytoany', 'hook-cursors'));
}
//# sourceMappingURL=prompt-hook.js.map