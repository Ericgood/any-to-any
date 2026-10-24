import type { SessionInfo } from '../adapters/types.js';
export interface SelfTarget {
    id: string;
    label: string;
}
export type SelfResolution = {
    ok: true;
    targets: SelfTarget[];
} | {
    ok: false;
    reason: 'ambiguous' | 'none';
    candidates: SessionInfo[];
};
export declare function resolveSelfSessions(sessions: readonly SessionInfo[], cwd: string, env?: Readonly<Record<string, string | undefined>>): SelfResolution;
/** Human-readable refusal for the CLI. */
export declare function describeSelfFailure(r: Extract<SelfResolution, {
    ok: false;
}>, cwd: string): string;
