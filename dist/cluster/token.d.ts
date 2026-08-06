/** Shared-secret pairing (ADR-002): same token on every device = one cluster. */
export declare function loadOrCreateToken(home?: string): string;
export declare function setToken(token: string, home?: string): void;
/** Short non-secret identifier shown in mDNS TXT to detect pairing state. */
export declare function tokenFingerprint(token: string): string;
