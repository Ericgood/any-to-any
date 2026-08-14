/**
 * Collaboration document — the durable coordination state for one conversation
 * (Phase 4 / ADR-017). A lead owns the machine-readable header + free-text body;
 * every agent appends only to its own progress section. All transforms are pure
 * and return a NEW document (immutability), so the file store can read-modify-write
 * under a lock without aliasing surprises.
 *
 * On-disk form: JSON inside a `---` front-matter fence (JSON is a strict YAML
 * subset, so the block stays human-readable and future YAML tooling still reads
 * it) followed by the lead body and one `## Progress — <agent>` section per agent.
 */

export type TaskState = 'assigned' | 'working' | 'done' | 'blocked' | 'needs-decision' | 'failed';

export const TASK_STATES: readonly TaskState[] = [
  'assigned',
  'working',
  'done',
  'blocked',
  'needs-decision',
  'failed',
];

export interface CollabTask {
  /** Short stable id, e.g. "t1". */
  id: string;
  /** Agent label that owns the task, e.g. "@codex:api". */
  owner: string;
  state: TaskState;
  /** Progress by product, not time: "2/4". */
  step?: string;
  /** Free note, e.g. what a blocked task is waiting on. */
  note?: string;
  /** ISO-8601 timestamp of the last state change. */
  updated: string;
  // ── Self-driving loop (ADR-020) — all optional; absent ⇒ not auto-driven ──
  /** true = "execute" task the daemon keeps nudging forward; absent/false =
   *  "design" round-trip that stops after a reply. Only the lead sets this. */
  autoRun?: boolean;
  /** ISO-8601 of the first auto-run tick — the 1h wall-clock backstop base. */
  startedAt?: string;
  /** ISO-8601 of the last auto-run tick — paces the scheduler. */
  lastTickAt?: string;
  /** Consecutive auto-run ticks that produced no new concrete product. */
  stallCount?: number;
  /** Fingerprint of the last observed product (worker progress + step) — a
   *  change means real forward motion; identical means a stall. */
  productFingerprint?: string;
  /** Fingerprint of the last BLOCKED reason, to detect the same wall being hit. */
  blockerFingerprint?: string;
  /** Consecutive ticks blocked on the same wall (→ escalate, don't burn rounds). */
  blockerRepeat?: number;
}

export interface ProgressSection {
  /** Agent label that owns (and exclusively appends to) this section. */
  agent: string;
  /** Append-only one-line bullets, oldest first. */
  entries: string[];
}

export interface CollabDoc {
  conversationId: string;
  /** Agent label of the single writer of the header + body. */
  lead: string;
  /** ISO-8601 timestamp of the last mutation. */
  updated: string;
  tasks: CollabTask[];
  /** Lead-owned free-text markdown (goals, division of labour, decision log). */
  body: string;
  /** Per-agent append-only progress, in first-seen order. */
  progress: ProgressSection[];
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PROGRESS_HEADING = '## Progress — ';

function assertLead(doc: CollabDoc, agent: string): void {
  if (agent !== doc.lead) {
    throw new Error(
      `only the lead (${doc.lead}) may edit the plan/tasks — ${agent} must append to its own progress or message the lead`,
    );
  }
}

export function createDoc(input: {
  conversationId: string;
  lead: string;
  updated: string;
  body?: string;
  tasks?: CollabTask[];
}): CollabDoc {
  return {
    conversationId: input.conversationId,
    lead: input.lead,
    updated: input.updated,
    tasks: input.tasks ? input.tasks.map((t) => ({ ...t })) : [],
    body: (input.body ?? '').trim(),
    progress: [],
  };
}

/** Replace the lead-owned body. Lead only. */
export function setBody(doc: CollabDoc, agent: string, body: string, updated: string): CollabDoc {
  assertLead(doc, agent);
  return { ...doc, body: body.trim(), updated };
}

/** Replace the whole task list. Lead only. */
export function setTasks(doc: CollabDoc, agent: string, tasks: CollabTask[], updated: string): CollabDoc {
  assertLead(doc, agent);
  return { ...doc, tasks: tasks.map((t) => ({ ...t })), updated };
}

/** Insert a task, or replace the existing one with the same id. Lead only. */
export function upsertTask(doc: CollabDoc, agent: string, taskIn: CollabTask, updated: string): CollabDoc {
  assertLead(doc, agent);
  const task = { ...taskIn };
  const exists = doc.tasks.some((t) => t.id === task.id);
  const tasks = exists ? doc.tasks.map((t) => (t.id === task.id ? task : t)) : [...doc.tasks, task];
  return { ...doc, tasks, updated };
}

/** Hand the lead role to another agent. Current lead only. */
export function setLead(doc: CollabDoc, agent: string, newLead: string, updated: string): CollabDoc {
  assertLead(doc, agent);
  return { ...doc, lead: newLead, updated };
}

/**
 * Append one progress bullet to the caller's OWN section (created on first use).
 * Any agent may do this — no lead role required. Newlines are collapsed so each
 * append stays a single bullet.
 */
export function appendProgress(doc: CollabDoc, agent: string, entry: string, updated: string): CollabDoc {
  const line = entry.replace(/\s*\n+\s*/g, ' ').trim();
  const idx = doc.progress.findIndex((p) => p.agent === agent);
  let progress: ProgressSection[];
  if (idx === -1) {
    progress = [...doc.progress, { agent, entries: [line] }];
  } else {
    const section = doc.progress[idx]!;
    const updatedSection: ProgressSection = { agent, entries: [...section.entries, line] };
    progress = doc.progress.map((p, i) => (i === idx ? updatedSection : p));
  }
  return { ...doc, progress, updated };
}

export function serialize(doc: CollabDoc): string {
  const header = {
    conversationId: doc.conversationId,
    lead: doc.lead,
    updated: doc.updated,
    tasks: doc.tasks,
  };
  let out = `---\n${JSON.stringify(header, null, 2)}\n---\n`;
  if (doc.body) out += `\n${doc.body}\n`;
  for (const section of doc.progress) {
    out += `\n${PROGRESS_HEADING}${section.agent}\n\n`;
    out += section.entries.map((e) => `- ${e}`).join('\n');
    out += '\n';
  }
  return out;
}

export function parse(text: string): CollabDoc {
  const fm = FRONT_MATTER_RE.exec(text);
  if (!fm || fm[1] === undefined) {
    throw new Error('malformed collab doc: missing --- front-matter fence');
  }
  let header: unknown;
  try {
    header = JSON.parse(fm[1]);
  } catch (e) {
    throw new Error(`malformed collab doc: front-matter is not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  const h = header as Record<string, unknown>;
  for (const field of ['conversationId', 'lead', 'updated'] as const) {
    if (typeof h[field] !== 'string') {
      throw new Error(`malformed collab doc: header field "${field}" must be a string`);
    }
  }
  if (!Array.isArray(h['tasks'])) {
    throw new Error('malformed collab doc: header field "tasks" must be an array');
  }

  const remainder = text.slice(fm[0].length);
  const lines = remainder.split('\n');
  const firstHeading = lines.findIndex((l) => l.startsWith(PROGRESS_HEADING));
  const bodyLines = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  const body = bodyLines.join('\n').trim();

  const progress: ProgressSection[] = [];
  if (firstHeading !== -1) {
    let current: ProgressSection | null = null;
    for (const line of lines.slice(firstHeading)) {
      if (line.startsWith(PROGRESS_HEADING)) {
        current = { agent: line.slice(PROGRESS_HEADING.length).trim(), entries: [] };
        progress.push(current);
      } else if (current && line.trim()) {
        current.entries.push(line.startsWith('- ') ? line.slice(2) : line);
      }
    }
  }

  return {
    conversationId: h['conversationId'] as string,
    lead: h['lead'] as string,
    updated: h['updated'] as string,
    tasks: (h['tasks'] as CollabTask[]).map((t) => ({ ...t })),
    body,
    progress,
  };
}
