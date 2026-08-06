import type { DeliveryAdapter, ExecFn } from './types.js';
interface ZcodeAdapterOptions {
    dbFile?: string;
    engineBin?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
    /** anytoany machine config (~/.anytoany/config.json) — delivery mode opt-in. */
    configFile?: string;
}
export declare function createZcodeAdapter(options?: ZcodeAdapterOptions): DeliveryAdapter;
export {};
