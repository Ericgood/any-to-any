export declare const REPLY_MARKER = "<<<ANYTOANY_REPLY>>>";
export interface EnvelopeInput {
    messageId: string;
    /** Human-readable sender label, e.g. '@claude:后端重构'. */
    fromLabel: string;
    text: string;
}
/**
 * Render the delivery prompt injected into the target session.
 * Injection-hardening by framing: the payload is explicitly labelled as data
 * from another agent, bounded by markers, with a no-privilege-escalation note.
 */
export declare function renderEnvelope(input: EnvelopeInput): string;
/** Extract the reply after the LAST marker occurrence; null when absent or empty. */
export declare function extractReply(stdout: string, marker?: string): string | null;
