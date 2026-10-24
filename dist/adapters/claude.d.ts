import type { DeliveryAdapter, ExecFn } from './types.js';
interface ClaudeAdapterOptions {
    /** Does a directory exist? Injectable for tests (default: the real filesystem). */
    dirExists?: (dir: string) => boolean;
    projectsDir?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createClaudeAdapter(options?: ClaudeAdapterOptions): DeliveryAdapter;
export {};
