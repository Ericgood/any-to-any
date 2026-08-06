import type { SessionInfo } from '../adapters/types.js';
export interface ParsedTarget {
    device?: string;
    agent: string;
    fragment?: string;
}
export type ResolveResult = {
    ok: true;
    session: SessionInfo;
} | {
    ok: false;
    reason: 'not_found' | 'ambiguous' | 'invalid_target';
    candidates: SessionInfo[];
};
/** Parse '@agent', '@agent:fragment' or '@device/agent:fragment'. Returns null on invalid syntax. */
export declare function parseTarget(raw: string): ParsedTarget | null;
/**
 * Resolve an @-target against the session directory.
 * Match priority: session id prefix > title substring > cwd basename substring
 * (all case-insensitive). No fragment means "most recently active session of that agent".
 */
export declare function resolveTarget(raw: string, sessions: SessionInfo[]): ResolveResult;
