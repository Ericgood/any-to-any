import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';

export interface PromptHookInput {
  session_id?: string;
  thread_id?: string;
}

export interface PromptHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

const label = (m: Message): string => `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}`;

function cursorPath(sessionId: string, home: string): string {
  return join(home, '.anytoany', 'hook-cursors', sessionId);
}

function readCursor(sessionId: string, home: string): number {
  try {
    const n = Number.parseInt(readFileSync(cursorPath(sessionId, home), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId: string, home: string, ts: number): void {
  const path = cursorPath(sessionId, home);
  mkdirSync(join(home, '.anytoany', 'hook-cursors'), { recursive: true });
  writeFileSync(path, String(ts), 'utf8');
}

function renderPending(m: Message): string {
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

function renderDigest(sessionId: string, handled: Message[]): string {
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
export function collectInbox(
  mailbox: Mailbox,
  sessionId: string,
  opts: { home?: string; now?: () => number } = {},
): string | null {
  const home = opts.home ?? anytoanyHome();
  const now = opts.now ?? Date.now;

  const blocks: string[] = [];

  const pending = mailbox.inbox({ toSession: sessionId, take: true, pendingOnly: true });
  for (const m of pending) blocks.push(renderPending(m));

  const cursor = readCursor(sessionId, home);
  const activity = mailbox
    .recentActivity(sessionId, cursor)
    .filter((m) => m.status === 'delivered' && !pending.some((p) => p.id === m.id));
  if (activity.length > 0) blocks.push(renderDigest(sessionId, activity));

  writeCursor(sessionId, home, now());
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Full recent cross-agent exchange for a session — read-only, ignores the cursor,
 * takes nothing. This is the "let me SEE what happened" view: once a message is
 * delivered (headlessly) and the cursor moves past it, `collectInbox` won't show
 * it again, but the live app never displayed it either. `anyd pull --history`
 * uses this to pull the whole recent exchange (both directions, including failed/
 * dead messages) back into the live session on demand.
 */
export function recentExchange(mailbox: Mailbox, sessionId: string, limit = 15): string | null {
  const msgs = mailbox.recentActivity(sessionId, 0, 500).slice(-limit);
  if (msgs.length === 0) return null;
  const lines = msgs.map((m) => {
    const received = m.to.sessionId === sessionId;
    const other = received ? m.from : m.to;
    const who = `@${other.agent}:${other.sessionId.slice(0, 8)}`;
    const undelivered = m.status === 'dead' || m.status === 'failed';
    const flag = undelivered ? `  ⚠️ ${m.status.toUpperCase()} — this one never reached you` : '';
    const text = m.parts.map((p) => p.text).join('\n');
    return `${received ? '←' : '→'} ${who} [${m.status}]${flag}\n${text}`;
  });
  return [
    `[anytoany] Recent cross-agent exchange for this session — full text, oldest→newest, context only`,
    `(these were already handled in headless turns; do NOT re-run or re-reply — this is so you can SEE what happened):`,
    ...lines,
  ].join('\n\n');
}

/**
 * Shared UserPromptSubmit processor for Claude Code and Codex (same output shape).
 * Two layers: pending messages are fully injected (and taken); already-handled
 * traffic since the last cursor is shown as an FYI digest — this is what makes
 * headless cross-agent activity visible inside the vendor app's own chat flow.
 */
export function processPromptHook(
  mailbox: Mailbox,
  input: PromptHookInput,
  opts: { home?: string; now?: () => number } = {},
): PromptHookOutput {
  const sessionId = input.session_id ?? input.thread_id;
  if (!sessionId) return {};
  const text = collectInbox(mailbox, sessionId, opts);
  return text
    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
    : {};
}

/** Backwards-compatible existence check used by doctor. */
export function hookCursorDirExists(home: string = anytoanyHome()): boolean {
  return existsSync(join(home, '.anytoany', 'hook-cursors'));
}
