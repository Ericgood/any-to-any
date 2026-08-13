import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
import {
  appendProgress as docAppendProgress,
  createDoc,
  parse,
  serialize,
  setBody as docSetBody,
  setLead as docSetLead,
  setTasks as docSetTasks,
  upsertTask as docUpsertTask,
  type CollabDoc,
  type CollabTask,
} from './doc.js';
import { withFileLock } from './lock.js';

/** Filesystem-backed collaboration-document store (one Markdown file per conversation). */
export interface CollabStore {
  path(conversationId: string): string;
  exists(conversationId: string): boolean;
  /** Read + parse; null when absent, throws when the file is corrupt. */
  load(conversationId: string): CollabDoc | null;
  /** All docs in the store, most-recently-updated first (corrupt files skipped). */
  list(): CollabDoc[];
  /** Create if absent (never clobbers an existing doc), then return it. */
  ensure(input: {
    conversationId: string;
    lead: string;
    body?: string;
    tasks?: CollabTask[];
  }): Promise<CollabDoc>;
  setBody(conversationId: string, agent: string, body: string): Promise<CollabDoc>;
  setTasks(conversationId: string, agent: string, tasks: CollabTask[]): Promise<CollabDoc>;
  upsertTask(conversationId: string, agent: string, task: CollabTask): Promise<CollabDoc>;
  setLead(conversationId: string, agent: string, newLead: string): Promise<CollabDoc>;
  appendProgress(conversationId: string, agent: string, entry: string): Promise<CollabDoc>;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function defaultCollabDir(): string {
  return join(anytoanyHome(), '.anytoany', 'collab');
}

export function createCollabStore(opts: { dir?: string; now?: () => number } = {}): CollabStore {
  const dir = opts.dir ?? defaultCollabDir();
  const now = opts.now ?? Date.now;
  const stamp = (): string => new Date(now()).toISOString();

  const assertId = (conversationId: string): void => {
    // conversationId becomes a filename — reject anything that could escape `dir`
    if (!SAFE_ID.test(conversationId)) {
      throw new Error(`invalid conversationId "${conversationId}" (allowed: A-Z a-z 0-9 . _ -)`);
    }
  };

  const path = (conversationId: string): string => {
    assertId(conversationId);
    return join(dir, `${conversationId}.md`);
  };

  const load = (conversationId: string): CollabDoc | null => {
    const file = path(conversationId);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return parse(raw);
  };

  const writeAtomic = async (conversationId: string, doc: CollabDoc): Promise<void> => {
    const file = path(conversationId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, serialize(doc), 'utf8');
    await rename(tmp, file); // atomic on the same filesystem — readers never see a torn file
  };

  /** Load → transform → persist, all under the per-doc file lock. */
  const mutate = async (
    conversationId: string,
    transform: (doc: CollabDoc, updated: string) => CollabDoc,
  ): Promise<CollabDoc> => {
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

  const list = (): CollabDoc[] => {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return []; // collab dir not created yet
    }
    const docs: CollabDoc[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue; // skip .md.tmp / .md.lock
      try {
        const doc = parse(readFileSync(join(dir, f), 'utf8'));
        docs.push(doc);
      } catch {
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
        if (existing) return existing;
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

    setBody: (conversationId, agent, body) =>
      mutate(conversationId, (doc, updated) => docSetBody(doc, agent, body, updated)),
    setTasks: (conversationId, agent, tasks) =>
      mutate(conversationId, (doc, updated) => docSetTasks(doc, agent, tasks, updated)),
    upsertTask: (conversationId, agent, task) =>
      mutate(conversationId, (doc, updated) => docUpsertTask(doc, agent, task, updated)),
    setLead: (conversationId, agent, newLead) =>
      mutate(conversationId, (doc, updated) => docSetLead(doc, agent, newLead, updated)),
    appendProgress: (conversationId, agent, entry) =>
      mutate(conversationId, (doc, updated) => docAppendProgress(doc, agent, entry, updated)),
  };
}
