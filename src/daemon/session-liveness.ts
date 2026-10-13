import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { liveClaudeInboxes } from './claude-inbox.js';

/**
 * Detect Claude sessions that are currently open in an INTERACTIVE process, so the
 * dispatcher does not headless-`claude -p --resume` into them (ADR-023).
 *
 * Why this matters (verified 2026-09-05 with real mailbox + transcript evidence):
 * resume-delivering into a live Claude session makes the injected turn physically
 * land in the transcript, yet `claude -p` still exits non-zero — a post-turn hook
 * chokes on a huge transcript ("Hook cancelled"), or the exit is simply 1 with an
 * empty stderr when a second process shares the session. Either way anytoany
 * false-failed and retried 3×, re-injecting duplicate turns into the session the
 * operator was actively using, before dead-lettering a message that had already
 * arrived. Live sessions are surfaced instead by their own pull hook / `anyd
 * monitor`, so the right move is to leave the message pending — exactly what we
 * already do for a monitored session (see monitor.ts).
 *
 * The interactive form is `--resume=<uuid>` (an `=`); our own headless delivery is
 * `--resume <uuid>` (a space), so matching the `=` form never matches a delivery.
 */

const UUID = /--resume=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** Pure: extract interactively-open Claude session ids from `ps` command output. */
export function parseLiveClaudeSessions(psOutput: string): Set<string> {
  const ids = new Set<string>();
  for (const match of psOutput.matchAll(UUID)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

const TTL_MS = 2_000;
let cache: { at: number; ids: Set<string> } | null = null;

/**
 * Session ids currently open in an interactive Claude process. Cached briefly so
 * the dispatch hot path can call it cheaply and synchronously. Best-effort: any
 * failure (no `ps`, not permitted, non-macOS/Linux) yields an empty set, so
 * delivery falls back to the normal resume path rather than blocking.
 */
export function liveClaudeSessions(now: () => number = Date.now): Set<string> {
  const t = now();
  if (cache && t - cache.at < TTL_MS) return cache.ids;
  let ids = new Set<string>();
  try {
    const out = execFileSync('ps', ['-axww', '-o', 'command'], { encoding: 'utf8', timeout: 4_000 });
    ids = parseLiveClaudeSessions(out);
  } catch {
    // no `ps` / not permitted — treat as "nothing known live"
  }
  cache = { at: t, ids };
  return ids;
}

/*
 * Codex twin (ADR-026). A Codex thread open in Codex Desktop refuses a headless
 * `codex exec resume` outright: "thread-store conflict: thread <id> already has an
 * active writer" — the turn never runs, so the 3 retries were pure noise before the
 * message dead-lettered. Upstream (codex-rs/rollout/src/writer_lock.rs) every writer
 * flock()s `<CODEX_HOME>/thread-writer-locks/<thread_id>.lock` and deletes the file
 * when it lets go; a crashed writer can leave an orphan file behind. So a thread is
 * live when its lock file exists AND some process holds it open — asked of `lsof`,
 * which is read-only. We never try the flock ourselves: holding it even for an
 * instant could make the user's own Codex Desktop fail to open that thread.
 */

const THREAD_LOCK = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/;

/** Pure: thread ids whose writer lock appears as an open file in `lsof -F n` output. */
export function parseCodexLockHolders(lsofOutput: string): Set<string> {
  const ids = new Set<string>();
  for (const line of lsofOutput.split('\n')) {
    if (!line.startsWith('n')) continue;
    const match = THREAD_LOCK.exec(line);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

export interface CodexLivenessOptions {
  /** `<CODEX_HOME>/thread-writer-locks` */
  lockDir?: string;
  /** Returns `lsof -F n` output for the given lock files. */
  holders?: (paths: string[]) => string;
  ttlMs?: number;
}

const lsofHolders = (paths: string[]): string =>
  // exits 1 when none of the files is open — that's an answer, not an error
  spawnSync('lsof', ['-F', 'n', '--', ...paths], { encoding: 'utf8', timeout: 4_000 }).stdout ?? '';

/** Build a cached probe for Codex threads that currently have a live writer. */
export function createCodexLiveness(options: CodexLivenessOptions = {}): (now?: () => number) => Set<string> {
  const lockDir = options.lockDir ?? join(homedir(), '.codex', 'thread-writer-locks');
  const holders = options.holders ?? lsofHolders;
  const ttlMs = options.ttlMs ?? TTL_MS;
  let cached: { at: number; ids: Set<string> } | null = null;
  return (now = Date.now) => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.ids;
    let ids = new Set<string>();
    try {
      const locks = readdirSync(lockDir)
        .filter((name) => THREAD_LOCK.test(name))
        .map((name) => join(lockDir, name));
      // the common case — no Codex thread open — costs a readdir, not a spawn
      if (locks.length > 0) ids = parseCodexLockHolders(holders(locks));
    } catch {
      // no Codex home / no lsof / not permitted — treat as "nothing known live"
    }
    cached = { at: t, ids };
    return ids;
  };
}

/** Codex thread ids currently held by a writer (typically Codex Desktop's app-server). */
export const liveCodexThreads = createCodexLiveness();

/**
 * Is this local session being run by a live process that surfaces its own mail, so
 * the dispatcher must NOT headless-resume into it? Claude only: the inbox registry
 * (ADR-027 — the only signal that sees desktop-App sessions, whose command line has
 * no `--resume=`) plus the `ps` scan (ADR-023). Live Codex threads are NOT skipped
 * any more: the codex adapter queues into Codex Desktop instead (ADR-027).
 */
export function isSessionLive(sessionId: string, now: () => number = Date.now): boolean {
  return liveClaudeInboxes().has(sessionId) || liveClaudeSessions(now).has(sessionId);
}
