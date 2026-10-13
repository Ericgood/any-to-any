export declare const REPLY_MARKER = "<<<ANYTOANY_REPLY>>>";
export interface EnvelopeInput {
    messageId: string;
    /** Human-readable sender label, e.g. '@claude:backend refactor'. */
    fromLabel: string;
    text: string;
    /** When this conversation has a shared collaboration doc (Phase 4), point the
     *  recipient at it and tell it the label to record progress under. */
    collab?: {
        conversationId: string;
        /** The recipient's own label, e.g. '@codex:api' — what it passes to --as. */
        selfLabel: string;
    };
    /** How the recipient answers. 'marker' (default): end the turn with a marker line
     *  that anytoany reads from the delivering CLI's stdout. 'command': the message was
     *  queued into an App's own runtime (Codex Desktop, ADR-027) — there is no stdout
     *  to read, so the recipient must run `anyd reply` itself. */
    replyVia?: 'marker' | 'command';
}
/**
 * Render the delivery prompt injected into the target session.
 * Trusted-teammate framing (ADR-016): the sender is a peer agent in the
 * operator's OWN shared-secret cluster, so a relayed request carries the
 * operator's delegated authority. The receiver collaborates in good faith and
 * keeps full autonomy — it does not refuse merely because the message came
 * from another agent or the authorization was relayed.
 */
export declare function renderEnvelope(input: EnvelopeInput): string;
/** Extract the reply after the LAST marker occurrence; null when absent or empty. */
export declare function extractReply(stdout: string, marker?: string): string | null;
