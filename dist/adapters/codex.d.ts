import type { DeliveryAdapter, ExecFn } from './types.js';
interface CodexAdapterOptions {
    sessionsDir?: string;
    indexFile?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
    /** anytoany machine config (~/.anytoany/config.json) — sandbox opt-in. */
    configFile?: string;
}
export declare function createCodexAdapter(options?: CodexAdapterOptions): DeliveryAdapter;
export {};
