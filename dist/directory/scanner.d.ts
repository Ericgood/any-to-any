import type { AgentAdapter, SessionInfo } from '../adapters/types.js';
export interface ScanError {
    agent: string;
    error: Error;
}
export interface ScanResult {
    /** All discovered sessions, most recently active first. */
    sessions: SessionInfo[];
    /** Per-adapter failures; one broken adapter must not break the directory. */
    errors: ScanError[];
}
export declare function listAllSessions(adapters: AgentAdapter[]): Promise<ScanResult>;
