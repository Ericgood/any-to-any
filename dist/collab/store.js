import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
import { appendProgress as docAppendProgress, createDoc, parse, serialize, setBody as docSetBody, setLead as docSetLead, setTasks as docSetTasks, upsertTask as docUpsertTask, } from './doc.js';
import { withFileLock } from './lock.js';
import { mergeDoc } from './merge.js';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
export function defaultCollabDir() {
    return join(anytoanyHome(), '.anytoany', 'collab');
}
export function createCollabStore(opts = {}) {
    const dir = opts.dir ?? defaultCollabDir();
    const now = opts.now ?? Date.now;
    const stamp = () => new Date(now()).toISOString();
    const assertId = (conversationId) => {
        // conversationId becomes a filename — reject anything that could escape `dir`
        if (!SAFE_ID.test(conversationId)) {
            throw new Error(`invalid conversationId "${conversationId}" (allowed: A-Z a-z 0-9 . _ -)`);
        }
    };
    const path = (conversationId) => {
        assertId(conversationId);
        return join(dir, `${conversationId}.md`);
    };
    const load = (conversationId) => {
        const file = path(conversationId);
        let raw;
        try {
            raw = readFileSync(file, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return null;
            throw e;
        }
        return parse(raw);
    };
    const writeAtomic = async (conversationId, doc) => {
        const file = path(conversationId);
        const tmp = `${file}.tmp`;
        await writeFile(tmp, serialize(doc), 'utf8');
        await rename(tmp, file); // atomic on the same filesystem — readers never see a torn file
    };
    /** Load → transform → persist, all under the per-doc file lock. */
    const mutate = async (conversationId, transform) => {
        const file = path(conversationId); // async fn: a bad-id throw surfaces as a rejection
        return withFileLock(`${file}.lock`, async () => {
            const current = load(conversationId);
            if (!current) {
                throw new Error(`no collab doc for conversation "${conversationId}" — create it first (anyd collab init)`);
            }
            const next = transform(current, stamp());
            await writeAtomic(conversationId, next);
            return next;
        });
    };
    const list = () => {
        let files;
        try {
            files = readdirSync(dir);
        }
        catch {
            return []; // collab dir not created yet
        }
        const docs = [];
        for (const f of files) {
            if (!f.endsWith('.md'))
                continue; // skip .md.tmp / .md.lock
            try {
                const doc = parse(readFileSync(join(dir, f), 'utf8'));
                docs.push(doc);
            }
            catch {
                // skip corrupt / partial files rather than failing the whole listing
            }
        }
        return docs.sort((a, b) => b.updated.localeCompare(a.updated));
    };
    return {
        path,
        exists: (conversationId) => existsSync(path(conversationId)),
        load,
        list,
        async ensure(input) {
            const file = path(input.conversationId);
            mkdirSync(dir, { recursive: true });
            return withFileLock(`${file}.lock`, async () => {
                const existing = load(input.conversationId);
                if (existing)
                    return existing;
                const doc = createDoc({
                    conversationId: input.conversationId,
                    lead: input.lead,
                    updated: stamp(),
                    ...(input.body !== undefined ? { body: input.body } : {}),
                    ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
                });
                await writeAtomic(input.conversationId, doc);
                return doc;
            });
        },
        async merge(incoming) {
            const file = path(incoming.conversationId);
            mkdirSync(dir, { recursive: true });
            return withFileLock(`${file}.lock`, async () => {
                const local = load(incoming.conversationId);
                // preserve the merged `updated` verbatim (do NOT re-stamp) or the two
                // machines would keep leap-frogging and never converge
                const next = local ? mergeDoc(local, incoming) : incoming;
                await writeAtomic(incoming.conversationId, next);
                return next;
            });
        },
        setBody: (conversationId, agent, body) => mutate(conversationId, (doc, updated) => docSetBody(doc, agent, body, updated)),
        setTasks: (conversationId, agent, tasks) => mutate(conversationId, (doc, updated) => docSetTasks(doc, agent, tasks, updated)),
        upsertTask: (conversationId, agent, task) => mutate(conversationId, (doc, updated) => docUpsertTask(doc, agent, task, updated)),
        setLead: (conversationId, agent, newLead) => mutate(conversationId, (doc, updated) => docSetLead(doc, agent, newLead, updated)),
        appendProgress: (conversationId, agent, entry) => mutate(conversationId, (doc, updated) => docAppendProgress(doc, agent, entry, updated)),
    };
}
//# sourceMappingURL=store.js.map