import type { DeliveryAdapter, ExecFn } from './types.js';
interface KimiAdapterOptions {
    /** Does a directory exist? Injectable for tests (default: the real filesystem). */
    dirExists?: (dir: string) => boolean;
    indexFile?: string;
    kimiBin?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
}
export declare function createKimiAdapter(options?: KimiAdapterOptions): DeliveryAdapter;
export {};
