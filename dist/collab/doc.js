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
export const TASK_STATES = [
    'assigned',
    'working',
    'done',
    'blocked',
    'needs-decision',
    'failed',
];
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const PROGRESS_HEADING = '## Progress — ';
function assertLead(doc, agent) {
    if (agent !== doc.lead) {
        throw new Error(`only the lead (${doc.lead}) may edit the plan/tasks — ${agent} must append to its own progress or message the lead`);
    }
}
export function createDoc(input) {
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
export function setBody(doc, agent, body, updated) {
    assertLead(doc, agent);
    return { ...doc, body: body.trim(), updated };
}
/** Replace the whole task list. Lead only. */
export function setTasks(doc, agent, tasks, updated) {
    assertLead(doc, agent);
    return { ...doc, tasks: tasks.map((t) => ({ ...t })), updated };
}
/** Insert a task, or replace the existing one with the same id. Lead only. */
export function upsertTask(doc, agent, taskIn, updated) {
    assertLead(doc, agent);
    const task = { ...taskIn };
    const exists = doc.tasks.some((t) => t.id === task.id);
    const tasks = exists ? doc.tasks.map((t) => (t.id === task.id ? task : t)) : [...doc.tasks, task];
    return { ...doc, tasks, updated };
}
/** Hand the lead role to another agent. Current lead only. */
export function setLead(doc, agent, newLead, updated) {
    assertLead(doc, agent);
    return { ...doc, lead: newLead, updated };
}
/**
 * Append one progress bullet to the caller's OWN section (created on first use).
 * Any agent may do this — no lead role required. Newlines are collapsed so each
 * append stays a single bullet.
 */
export function appendProgress(doc, agent, entry, updated) {
    const line = entry.replace(/\s*\n+\s*/g, ' ').trim();
    const idx = doc.progress.findIndex((p) => p.agent === agent);
    let progress;
    if (idx === -1) {
        progress = [...doc.progress, { agent, entries: [line] }];
    }
    else {
        const section = doc.progress[idx];
        const updatedSection = { agent, entries: [...section.entries, line] };
        progress = doc.progress.map((p, i) => (i === idx ? updatedSection : p));
    }
    return { ...doc, progress, updated };
}
export function serialize(doc) {
    const header = {
        conversationId: doc.conversationId,
        lead: doc.lead,
        updated: doc.updated,
        tasks: doc.tasks,
    };
    let out = `---\n${JSON.stringify(header, null, 2)}\n---\n`;
    if (doc.body)
        out += `\n${doc.body}\n`;
    for (const section of doc.progress) {
        out += `\n${PROGRESS_HEADING}${section.agent}\n\n`;
        out += section.entries.map((e) => `- ${e}`).join('\n');
        out += '\n';
    }
    return out;
}
export function parse(text) {
    const fm = FRONT_MATTER_RE.exec(text);
    if (!fm || fm[1] === undefined) {
        throw new Error('malformed collab doc: missing --- front-matter fence');
    }
    let header;
    try {
        header = JSON.parse(fm[1]);
    }
    catch (e) {
        throw new Error(`malformed collab doc: front-matter is not valid JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
    const h = header;
    for (const field of ['conversationId', 'lead', 'updated']) {
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
    const progress = [];
    if (firstHeading !== -1) {
        let current = null;
        for (const line of lines.slice(firstHeading)) {
            if (line.startsWith(PROGRESS_HEADING)) {
                current = { agent: line.slice(PROGRESS_HEADING.length).trim(), entries: [] };
                progress.push(current);
            }
            else if (current && line.trim()) {
                current.entries.push(line.startsWith('- ') ? line.slice(2) : line);
            }
        }
    }
    return {
        conversationId: h['conversationId'],
        lead: h['lead'],
        updated: h['updated'],
        tasks: h['tasks'].map((t) => ({ ...t })),
        body,
        progress,
    };
}
//# sourceMappingURL=doc.js.map