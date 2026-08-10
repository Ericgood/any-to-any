import type { DeliveryAdapter, ExecFn } from './types.js';
interface KimiAdapterOptions {
    indexFile?: string;
    kimiBin?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createKimiAdapter(options?: KimiAdapterOptions): DeliveryAdapter;
export {};
