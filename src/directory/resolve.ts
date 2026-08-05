import { basename } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';

export interface ParsedTarget {
  device?: string;
  agent: string;
  fragment?: string;
}

export type ResolveResult =
  | { ok: true; session: SessionInfo }
  | {
      ok: false;
      reason: 'not_found' | 'ambiguous' | 'unsupported_device' | 'invalid_target';
      candidates: SessionInfo[];
    };

const TARGET_RE = /^@(?:([A-Za-z0-9_-]+)\/)?([A-Za-z0-9_-]+)(?::(.+))?$/;

/** Parse '@agent', '@agent:fragment' or '@device/agent:fragment'. Returns null on invalid syntax. */
export function parseTarget(raw: string): ParsedTarget | null {
  const m = TARGET_RE.exec(raw.trim());
  if (!m) return null;
  const [, device, agent, fragment] = m;
  if (!agent) return null;
  const out: ParsedTarget = { agent: agent.toLowerCase() };
  if (device) out.device = device.toLowerCase();
  if (fragment) out.fragment = fragment;
  return out;
}

const byRecency = (a: SessionInfo, b: SessionInfo) => b.lastActiveAt - a.lastActiveAt;

/**
 * Resolve an @-target against the session directory.
 * Match priority: session id prefix > title substring > cwd basename substring
 * (all case-insensitive). No fragment means "most recently active session of that agent".
 */
export function resolveTarget(raw: string, sessions: SessionInfo[]): ResolveResult {
  const parsed = parseTarget(raw);
  if (!parsed) return { ok: false, reason: 'invalid_target', candidates: [] };
  if (parsed.device) return { ok: false, reason: 'unsupported_device', candidates: [] };

  const pool = sessions.filter((s) => s.agent === parsed.agent).sort(byRecency);
  if (pool.length === 0) return { ok: false, reason: 'not_found', candidates: [] };

  const first = pool[0];
  if (!parsed.fragment) {
    return first ? { ok: true, session: first } : { ok: false, reason: 'not_found', candidates: [] };
  }

  const frag = parsed.fragment.toLowerCase();
  const byId = pool.filter((s) => s.sessionId.toLowerCase().startsWith(frag));
  const byTitle = pool.filter((s) => s.title.toLowerCase().includes(frag));
  const byCwd = pool.filter((s) => basename(s.cwd).toLowerCase().includes(frag));
  const hits = byId.length > 0 ? byId : byTitle.length > 0 ? byTitle : byCwd;

  const only = hits[0];
  if (hits.length === 1 && only) return { ok: true, session: only };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
  return { ok: false, reason: 'not_found', candidates: pool };
}
