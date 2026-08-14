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
export declare const TASK_STATES: readonly TaskState[];
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
export declare function createDoc(input: {
    conversationId: string;
    lead: string;
    updated: string;
    body?: string;
    tasks?: CollabTask[];
}): CollabDoc;
/** Replace the lead-owned body. Lead only. */
export declare function setBody(doc: CollabDoc, agent: string, body: string, updated: string): CollabDoc;
/** Replace the whole task list. Lead only. */
export declare function setTasks(doc: CollabDoc, agent: string, tasks: CollabTask[], updated: string): CollabDoc;
/** Insert a task, or replace the existing one with the same id. Lead only. */
export declare function upsertTask(doc: CollabDoc, agent: string, taskIn: CollabTask, updated: string): CollabDoc;
/** Hand the lead role to another agent. Current lead only. */
export declare function setLead(doc: CollabDoc, agent: string, newLead: string, updated: string): CollabDoc;
/**
 * Append one progress bullet to the caller's OWN section (created on first use).
 * Any agent may do this — no lead role required. Newlines are collapsed so each
 * append stays a single bullet.
 */
export declare function appendProgress(doc: CollabDoc, agent: string, entry: string, updated: string): CollabDoc;
export declare function serialize(doc: CollabDoc): string;
export declare function parse(text: string): CollabDoc;
