import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';

/**
 * Live in-session delivery ("monitor" mode, borrowed from agmsg's design).
 *
 * Instead of the daemon pushing a message via a headless `resume` (which appends
 * an invisible turn — see Codex #28259), the LIVE agent session runs a blocking
 * `anyd monitor` that pulls messages addressed to it and prints them IN ITS OWN
 * TURN, so they appear in the live UI naturally. While a session is monitoring it
 * writes a heartbeat here; the dispatcher checks it and does NOT resume-deliver to
 * a monitored session — it leaves the message pending for the monitor to pull.
 */

const FRESH_MS = 10_000;

/** Session ids become filenames — keep them filesystem-safe. */
const safe = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9._-]/g, '_');

function monitorDir(home: string): string {
  return join(home, '.anytoany', 'monitors');
}
function monitorPath(sessionId: string, home: string): string {
  return join(monitorDir(home), safe(sessionId));
}

/** Mark this session as actively monitored (call each poll to keep it fresh). */
export function heartbeat(sessionId: string, opts: { home?: string; now?: () => number } = {}): void {
  const home = opts.home ?? anytoanyHome();
  const now = opts.now ?? Date.now;
  mkdirSync(monitorDir(home), { recursive: true });
  writeFileSync(monitorPath(sessionId, home), String(now()), 'utf8');
}

/** Remove the heartbeat (on monitor exit). Best-effort. */
export function clearMonitor(sessionId: string, opts: { home?: string } = {}): void {
  try {
    rmSync(monitorPath(sessionId, opts.home ?? anytoanyHome()), { force: true });
  } catch {
    /* already gone */
  }
}

/** Is this session actively monitoring right now (fresh heartbeat)? */
export function isMonitored(
  sessionId: string,
  opts: { home?: string; now?: () => number; freshMs?: number } = {},
): boolean {
  const home = opts.home ?? anytoanyHome();
  const now = opts.now ?? Date.now;
  const freshMs = opts.freshMs ?? FRESH_MS;
  const path = monitorPath(sessionId, home);
  if (!existsSync(path)) return false;
  try {
    const ts = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(ts) && now() - ts <= freshMs;
  } catch {
    return false;
  }
}
