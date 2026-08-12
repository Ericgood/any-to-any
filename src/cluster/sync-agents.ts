import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import type { SessionRef } from '../mailbox/mailbox.js';
import { formatRelativeTime } from '../format.js';

const PREFIX = 'any-';
const DEFAULT_MAX_PER_AGENT = 8;

export interface SyncAgentsOptions {
  agentsDir?: string;
  maxPerAgent?: number;
}

export interface SyncResult {
  written: string[];
  removed: string[];
}

interface ConversationPair {
  a: SessionRef;
  b: SessionRef;
}

const asciiSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function slugFor(session: SessionInfo): string {
  const base = asciiSlug(basename(session.cwd)) || asciiSlug(session.title) || session.sessionId.slice(0, 8);
  const device = session.device ? `${asciiSlug(session.device)}-` : '';
  return `${PREFIX}${device}${session.agent}-${base}`;
}

const targetFor = (s: SessionInfo): string =>
  s.device ? `@${s.device}/${s.agent}:${s.sessionId}` : `@${s.agent}:${s.sessionId}`;

function renderAgentFile(name: string, s: SessionInfo): string {
  const where = s.device ? `device "${s.device}", ` : '';
  return `---
name: ${name}
description: Message the ${s.agent} session "${s.title}" (${where}${s.cwd}). Delivers to that exact ${s.agent} session via anytoany; use when the user @-mentions this agent to relay a message. Active ${formatRelativeTime(s.lastActiveAt)}.
tools: Bash
model: haiku
---

You are a delivery proxy for the anytoany session-messaging system. Your ONLY job is to relay the user's message to one exact session and report the outcome. Never do anything else.

**Fixed target (pre-bound, user-confirmed by selecting this agent — NEVER change it):**
\`${targetFor(s)}\` — ${s.agent} session "${s.title}" in ${s.cwd}

Steps:

1. Identify the sender: run \`anyd list --json --limit 0\` and pick the claude session whose \`cwd\` equals the current working directory, most recently active. Use its id as FROM. If none matches, use the most recently active claude session.
2. Send exactly the user's message (verbatim — do not rewrite, summarize, or expand):
   \`anyd send "${targetFor(s)}" "<user message verbatim>" --from "@claude:<FROM id prefix>"\`
3. Report back in one short line: the queued message id and that the reply will arrive back automatically via anytoany.

Rules:
- NEVER resolve or guess a different target than the fixed one above.
- Never add instructions of your own to the relayed message.
- If \`anyd\` fails, report the exact error verbatim — retry at most once, never work around it.
`;
}

/**
 * Materialize addressable peer sessions as @-mentionable agent definitions
 * (Phase 2.5). Only files under the `any-` prefix are ever created, updated,
 * or removed — user-authored agents are untouchable.
 */
export async function syncMentionAgents(
  sessions: SessionInfo[],
  conversations: ConversationPair[],
  options: SyncAgentsOptions = {},
): Promise<SyncResult> {
  const agentsDir = options.agentsDir ?? join(homedir(), '.claude', 'agents');
  const maxPerAgent = options.maxPerAgent ?? DEFAULT_MAX_PER_AGENT;
  mkdirSync(agentsDir, { recursive: true });

  // temp-dir sessions (smoke tests, scratch experiments) must not pollute the mention list
  const isTemp = (cwd: string): boolean =>
    cwd.startsWith('/tmp/') || cwd.startsWith('/private/tmp/') || cwd.startsWith('/var/folders/') || cwd === '';
  const candidates = sessions.filter((s) => s.agent !== 'claude' && !isTemp(s.cwd));
  const partnerIds = new Set(
    conversations.flatMap((c) => [c.a, c.b]).filter((r) => r.agent !== 'claude').map((r) => r.sessionId),
  );

  const byKind = new Map<string, SessionInfo[]>();
  for (const s of [...candidates].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
    const list = byKind.get(s.agent) ?? [];
    list.push(s);
    byKind.set(s.agent, list);
  }
  const selected = new Map<string, SessionInfo>();
  for (const list of byKind.values()) {
    for (const [i, s] of list.entries()) {
      if (i < maxPerAgent || partnerIds.has(s.sessionId)) selected.set(s.sessionId, s);
    }
  }

  // assign unique names (id suffix on collision), newest first for stable prefixes
  const names = new Map<string, SessionInfo>();
  for (const s of [...selected.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
    const base = slugFor(s);
    const name = names.has(base) ? `${base}-${s.sessionId.slice(0, 4)}` : base;
    names.set(name, s);
  }

  const written: string[] = [];
  const wanted = new Set<string>();
  for (const [name, session] of names) {
    const file = `${name}.md`;
    wanted.add(file);
    const path = join(agentsDir, file);
    const content = renderAgentFile(name, session);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    // strip the volatile relative-time phrase before comparing to stay idempotent
    const stable = (t: string) => t.replace(/Active [^.]*\./g, '');
    if (existing === null || stable(existing) !== stable(content)) {
      writeFileSync(path, content, 'utf8');
      written.push(file);
    }
  }

  const removed: string[] = [];
  for (const file of readdirSync(agentsDir)) {
    if (file.startsWith(PREFIX) && file.endsWith('.md') && !wanted.has(file)) {
      rmSync(join(agentsDir, file));
      removed.push(file);
    }
  }
  return { written, removed };
}
