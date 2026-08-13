/** Mark this session as actively monitored (call each poll to keep it fresh). */
export declare function heartbeat(sessionId: string, opts?: {
    home?: string;
    now?: () => number;
}): void;
/** Remove the heartbeat (on monitor exit). Best-effort. */
export declare function clearMonitor(sessionId: string, opts?: {
    home?: string;
}): void;
/** Is this session actively monitoring right now (fresh heartbeat)? */
export declare function isMonitored(sessionId: string, opts?: {
    home?: string;
    now?: () => number;
    freshMs?: number;
}): boolean;
