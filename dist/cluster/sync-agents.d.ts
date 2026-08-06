import type { SessionInfo } from '../adapters/types.js';
import type { SessionRef } from '../mailbox/mailbox.js';
export interface SyncAgentsOptions {
    agentsDir?: string;
    maxPerAgent?: number;
}
export interface SyncResult {
    written: string[];
    removed: string[];
}
interface ConversationPair {
    a: SessionRef;
    b: SessionRef;
}
/**
 * Materialize addressable peer sessions as @-mentionable agent definitions
 * (Phase 2.5). Only files under the `any-` prefix are ever created, updated,
 * or removed — user-authored agents are untouchable.
 */
export declare function syncMentionAgents(sessions: SessionInfo[], conversations: ConversationPair[], options?: SyncAgentsOptions): Promise<SyncResult>;
export {};
