interface Check {
    name: string;
    ok: boolean;
    note: string;
}
/**
 * Can the Claude doorbell wake a running session (ADR-027)? Claude Code holds a
 * peer message for approval when the receiver bypasses permission prompts, and the
 * desktop App can't show that dialog — so the frame expires. The pull hook still
 * delivers on the next prompt; `accept` is what makes delivery immediate. Changing
 * it is the owner's call, so this only reports.
 */
export declare function crossSessionInboundCheck(settings: {
    crossSessionInbound?: unknown;
    permissions?: {
        defaultMode?: unknown;
    };
} | null): Check;
export declare function runDoctor(): Promise<boolean>;
export {};
