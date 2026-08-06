import type { DeliveryAdapter, ExecFn } from './types.js';
interface ClaudeAdapterOptions {
    projectsDir?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createClaudeAdapter(options?: ClaudeAdapterOptions): DeliveryAdapter;
export {};
