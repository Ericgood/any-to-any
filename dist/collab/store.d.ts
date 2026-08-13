import { type CollabDoc, type CollabTask } from './doc.js';
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
    /** Merge a peer's copy into the local one (M3 cross-device sync). Writes the
     *  incoming doc verbatim when this machine has never seen it. Convergent. */
    merge(incoming: CollabDoc): Promise<CollabDoc>;
}
export declare function defaultCollabDir(): string;
export declare function createCollabStore(opts?: {
    dir?: string;
    now?: () => number;
}): CollabStore;
