import type { DeliveryAdapter, ExecFn } from './types.js';
interface CodexAdapterOptions {
    sessionsDir?: string;
    indexFile?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createCodexAdapter(options?: CodexAdapterOptions): DeliveryAdapter;
export {};
