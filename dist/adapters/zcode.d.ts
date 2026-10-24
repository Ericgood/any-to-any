import type { DeliveryAdapter, ExecFn } from './types.js';
interface ZcodeAdapterOptions {
    /** Does a directory exist? Injectable for tests (default: the real filesystem). */
    dirExists?: (dir: string) => boolean;
    dbFile?: string;
    engineBin?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
    /** anytoany machine config (~/.anytoany/config.json) — delivery mode opt-in. */
    configFile?: string;
    /** ZCode session mailbox root (ADR-029); defaults to ZCODE_MAILBOX_ROOT / ~/.zcode/mailbox. */
    mailboxRoot?: string;
    /** Is the session mid-turn right now? Defaults to reading ZCode's message table. */
    isBusy?: (sessionId: string) => boolean;
    /** How often to check whether ZCode picked the letter up. */
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
export declare function createZcodeAdapter(options?: ZcodeAdapterOptions): DeliveryAdapter;
export {};
