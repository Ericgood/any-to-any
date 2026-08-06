import type { DeliveryAdapter, ExecFn } from './types.js';
interface ZcodeAdapterOptions {
    dbFile?: string;
    engineBin?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createZcodeAdapter(options?: ZcodeAdapterOptions): DeliveryAdapter;
export {};
