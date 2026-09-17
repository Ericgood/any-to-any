import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';

/**
 * External agent registry (ADR-024).
 *
 * Some agents live inside a desktop App and have no headless CLI we can resume
 * into — 闪电说 (`sds`) is the first: its assistant shell runs with a minimal
 * PATH, a workspace-write sandbox that blocks writes to ~/.anytoany, and no
 * self-drive at all. Such an agent instead REGISTERS itself here (over HTTP,
 * via the daemon) so it becomes an addressable first-class target, and PULLS
 * its own mail.
 *
 * Registered sessions are "pull-only": the dispatcher must never headless-
 * resume them — messages stay pending until the agent fetches them. This
 * reuses the same skip mechanism as `monitor.ts` / `session-liveness.ts`
 * (ADR-019 / ADR-023); the storage layout mirrors monitor.ts deliberately.
 */

export interface ExternalSession {
  agent: string;
  sessionId: string;
  title: string;
  cwd: string;
  /** epoch ms of the FIRST registration — preserved across re-registrations. */
  registeredAt: number;
  /** epoch ms of the most recent registration/heartbeat. */
  lastSeenAt: number;
}

export interface RegisterInput {
  agent: string;
  sessionId: string;
  title?: string;
  cwd?: string;
}

interface StoreOpts {
  home?: string;
  now?: () => number;
}

/** Agent names that already mean something else — registering them would make
 *  the directory ambiguous. `user` is the mailbox-as-inbox sink (dispatcher),
 *  the rest have real delivery adapters. */
export const RESERVED_AGENT_NAMES = ['user', 'claude', 'codex', 'kimi', 'zcode'] as const;

/** A registration is a long-lived identity, not a liveness heartbeat — but an
 *  uninstalled app must not own its @-name forever. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Session ids become filenames — keep them filesystem-safe (same rule as monitor.ts). */
const safe = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');

function registryDir(home: string): string {
  return join(home, '.anytoany', 'registered');
}

function entryPath(agent: string, sessionId: string, home: string): string {
  return join(registryDir(home), `${safe(agent)}-${safe(sessionId)}.json`);
}

function assertValid(input: RegisterInput): void {
  if ((RESERVED_AGENT_NAMES as readonly string[]).includes(input.agent)) {
    throw new Error(
      `agent name "${input.agent}" is reserved (${RESERVED_AGENT_NAMES.join(', ')}) — pick another name`,
    );
  }
  if (!AGENT_NAME_RE.test(input.agent)) {
    throw new Error(
      `invalid agent name "${input.agent}" — use lowercase letters, digits and dashes, 2-32 chars, starting with a letter`,
    );
  }
  if (!input.sessionId || !input.sessionId.trim()) {
    throw new Error('a session id is required to register an external agent session');
  }
}

/** Register (or refresh) an external agent session. Upsert: re-registering the
 *  same agent+session keeps `registeredAt` and only moves `lastSeenAt`. */
export function register(input: RegisterInput, opts: StoreOpts = {}): ExternalSession {
  assertValid(input);
  const home = opts.home ?? anytoanyHome();
  const now = (opts.now ?? Date.now)();

  const path = entryPath(input.agent, input.sessionId, home);
  const existing = readEntry(path);

  // An upsert only overwrites what it actually carries: the per-turn heartbeat
  // an external agent sends may be just {agent, sessionId}, and it must not wipe
  // the title/cwd the first, fuller registration established.
  const session: ExternalSession = {
    agent: input.agent,
    sessionId: input.sessionId,
    title: input.title?.trim() || existing?.title || input.agent,
    cwd: input.cwd ?? existing?.cwd ?? '',
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
  };

  mkdirSync(registryDir(home), { recursive: true });
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
  return session;
}

/** Forget a registration. Best-effort and idempotent. */
export function unregister(agent: string, sessionId: string, opts: { home?: string } = {}): void {
  try {
    rmSync(entryPath(agent, sessionId, opts.home ?? anytoanyHome()), { force: true });
  } catch {
    /* already gone */
  }
}

function readEntry(path: string): ExternalSession | null {
  try {
    if (!statSync(path).isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExternalSession>;
    if (typeof parsed.agent !== 'string' || typeof parsed.sessionId !== 'string') return null;
    return {
      agent: parsed.agent,
      sessionId: parsed.sessionId,
      title: typeof parsed.title === 'string' ? parsed.title : parsed.agent,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      registeredAt: typeof parsed.registeredAt === 'number' ? parsed.registeredAt : 0,
      lastSeenAt: typeof parsed.lastSeenAt === 'number' ? parsed.lastSeenAt : 0,
    };
  } catch {
    // A corrupt or unreadable entry must never break the whole directory scan.
    return null;
  }
}

/** All registered sessions, most recently seen first. Stale ones are hidden
 *  (their files are kept — re-registering revives the same identity). */
export function listRegistered(
  opts: StoreOpts & { ttlMs?: number; includeStale?: boolean } = {},
): ExternalSession[] {
  const home = opts.home ?? anytoanyHome();
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? TTL_MS;
  const dir = registryDir(home);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readEntry(join(dir, n)))
    .filter((s): s is ExternalSession => s !== null)
    .filter((s) => opts.includeStale || now - s.lastSeenAt <= ttlMs)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Is this session id a registered (pull-only) external session?
 *
 * Used by the dispatcher's claim filter, which only receives a session id — no
 * agent. Deliberately ignores the TTL: a stale external session cannot be
 * headless-resumed either, so skipping it keeps the message pending instead of
 * dead-lettering it.
 */
export function isRegisteredSession(sessionId: string, opts: StoreOpts = {}): boolean {
  return listRegistered({ ...opts, includeStale: true }).some((s) => s.sessionId === sessionId);
}
