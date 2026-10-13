import type { DeliveryAdapter, ExecFn } from './types.js';
/** Error-code prefix for a thread another Codex process is writing to (ADR-026). */
export declare const THREAD_BUSY = "codex_thread_busy";
interface CodexAdapterOptions {
    sessionsDir?: string;
    indexFile?: string;
    exec?: ExecFn;
    deliverTimeoutMs?: number;
    /** anytoany machine config (~/.anytoany/config.json) — sandbox opt-in. */
    configFile?: string;
    /** Is the thread held open by another Codex process (Codex Desktop)? ADR-026/027. */
    isThreadLive?: (threadId: string) => boolean;
}
export declare function createCodexAdapter(options?: CodexAdapterOptions): DeliveryAdapter;
export {};
