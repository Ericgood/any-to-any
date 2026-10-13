import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mailbox } from '../mailbox/mailbox.js';

/**
 * The Claude doorbell (ADR-027).
 *
 * Claude Code v2.1.224+ gives every session — desktop App ones included — a local
 * inbox: a Unix socket registered in `~/.claude/sessions/<pid>.json`. A line written
 * to it makes an idle session start a turn (a busy one reads it between tool calls),
 * and that turn fires UserPromptSubmit, i.e. anytoany's existing pull hook.
 *
 * So the doorbell carries NO message content — just "you have mail". The message
 * stays pending in the mailbox and the hook injects it with the usual framing and
 * `anyd reply` path. If the frame is held (a bypass-mode receiver without
 * `crossSessionInbound: accept`) or lost, nothing is lost: the hook still delivers
 * it on the user's next prompt — the pre-ADR-027 behaviour.
 *
 * We never read the `<pid>.*.key` tokens next to the registry: a token would make
 * the frame count as the session's own child and skip its inbound controls.
 * Verified live on 2.1.296, 2026-10-13. The wire format is the community-captured
 * one (agents-can-communicate #130), not an official spec — hence fail-soft.
 */

export interface InboxEntry {
  pid: number;
  sessionId: string;
  socketPath: string;
  status?: string;
  version?: string;
}

const DEFAULT_TTL_MS = 2_000;
const RING_TIMEOUT_MS = 3_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = gone; EPERM = another user's process — not one of our sessions either way
    return false;
  }
}

function parseEntry(raw: string): InboxEntry | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const { pid, sessionId, messagingSocketPath, status, version } = d;
    if (typeof pid !== 'number' || typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
    if (typeof messagingSocketPath !== 'string' || !messagingSocketPath) return null;
    return {
      pid,
      sessionId,
      socketPath: messagingSocketPath,
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof version === 'string' ? { version } : {}),
    };
  } catch {
    return null;
  }
}

export interface InboxRegistryOptions {
  /** `~/.claude/sessions` */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  ttlMs?: number;
  now?: () => number;
}

/** Cached probe: sessionId → inbox, for Claude sessions that are running right now. */
export function createClaudeInboxRegistry(options: InboxRegistryOptions = {}): () => Map<string, InboxEntry> {
  const dir = options.dir ?? join(homedir(), '.claude', 'sessions');
  const isAlive = options.isAlive ?? pidAlive;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; map: Map<string, InboxEntry> } | null = null;
  return () => {
    const t = now();
    if (cached && t - cached.at < ttlMs) return cached.map;
    const map = new Map<string, InboxEntry>();
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      // no ~/.claude/sessions — Claude Code too old or not installed
    }
    for (const name of names) {
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const entry = parseEntry(raw);
      // a crashed session leaves its file behind — require a live pid AND the socket
      if (entry && isAlive(entry.pid) && existsSync(entry.socketPath)) map.set(entry.sessionId, entry);
    }
    cached = { at: t, map };
    return map;
  };
}

/** One newline-terminated inbox frame: "you have mail", never the mail itself. */
export function buildDoorbellFrame(input: { messageIds: string[]; fromLabel: string }): string {
  const n = input.messageIds.length;
  const content = [
    `[anytoany] Doorbell: ${n} new cross-agent message${n === 1 ? '' : 's'} for this session (from ${input.fromLabel}).`,
    `The anytoany inbox hook attaches ${n === 1 ? 'it' : 'them'} to this turn — handle ${n === 1 ? 'it' : 'them'} there.`,
    `If nothing from anytoany is attached, run: anyd pull`,
  ].join('\n');
  const frame = {
    type: 'user',
    message: { role: 'user', content },
    msg_id: `anytoany-${input.messageIds[0] ?? 'wake'}`,
    priority: 'next',
  };
  return `${JSON.stringify(frame)}\n`;
}

/** Write one frame to a session's inbox socket. Never throws. */
export function ringInbox(
  socketPath: string,
  frame: string,
  timeoutMs: number = RING_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => done({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    socket.on('error', (e) => done({ ok: false, error: e.message }));
    socket.on('connect', () => {
      socket.end(frame, () => done({ ok: true }));
    });
  });
}

/**
 * Will a ring actually wake anyone? Verified 2026-10-13: with the user-level default
 * `permissions.defaultMode: "bypassPermissions"` and no `crossSessionInbound`, every
 * session holds the frame (`peer_message_hold`, cause `no-mode-asserted`) and the
 * desktop App can't show the approval dialog — the ring only leaves held notices
 * behind. In that configuration we don't ring at all; the pull hook delivers on the
 * next prompt exactly as before. An explicit `accept` (or a prompting default) rings.
 */
export function doorbellUseful(settings: { crossSessionInbound?: unknown; permissions?: { defaultMode?: unknown } } | null): boolean {
  if (settings?.crossSessionInbound === 'accept') return true;
  if (settings?.crossSessionInbound === 'refuse' || settings?.crossSessionInbound === 'hold') return false;
  return settings?.permissions?.defaultMode !== 'bypassPermissions';
}

export interface DoorbellEvent {
  kind: 'rung' | 'ring-failed';
  sessionId: string;
  messageIds: string[];
  detail?: string;
}

export interface DoorbellOptions {
  mailbox: Mailbox;
  inboxes: () => Map<string, InboxEntry>;
  ring?: (socketPath: string, frame: string) => Promise<{ ok: boolean; error?: string }>;
  onEvent?: (event: DoorbellEvent) => void;
  /** Gate re-read each tick (cheap): false = don't ring, see doorbellUseful. */
  enabled?: () => boolean;
}

/**
 * Each tick: pending mail addressed to a running local Claude session gets ONE
 * ring per batch. A message is rung at most once (success or not) — the pull hook
 * is the safety net, so a dead socket must never turn into a ring storm.
 */
export function createDoorbell(opts: DoorbellOptions): { tick(): Promise<void> } {
  const ring = opts.ring ?? ringInbox;
  const rung = new Set<string>();
  return {
    async tick() {
      if (opts.enabled && !opts.enabled()) return;
      const inboxes = opts.inboxes();
      if (inboxes.size === 0) return;
      const waiting = new Map<string, { ids: string[]; from: string }>();
      for (const m of opts.mailbox.inbox({ pendingOnly: true })) {
        if (m.to.agent !== 'claude' || m.to.device || rung.has(m.id) || !inboxes.has(m.to.sessionId)) continue;
        const batch = waiting.get(m.to.sessionId) ?? { ids: [], from: `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}` };
        waiting.set(m.to.sessionId, { ...batch, ids: [...batch.ids, m.id] });
      }
      for (const [sessionId, { ids, from }] of waiting) {
        const inbox = inboxes.get(sessionId);
        if (!inbox) continue;
        for (const id of ids) rung.add(id);
        const r = await ring(inbox.socketPath, buildDoorbellFrame({ messageIds: ids, fromLabel: from }));
        opts.onEvent?.(
          r.ok
            ? { kind: 'rung', sessionId, messageIds: ids }
            : { kind: 'ring-failed', sessionId, messageIds: ids, detail: r.error ?? 'unknown error' },
        );
      }
    },
  };
}

/** Shared registry instance for the daemon (liveness + doorbell). */
export const liveClaudeInboxes = createClaudeInboxRegistry();
