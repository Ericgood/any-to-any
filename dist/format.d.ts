/** '2m ago', '3h ago', '5d ago' — coarse relative time for directory listings. */
export declare function formatRelativeTime(epochMs: number, nowMs?: number): string;
/** Abbreviate the user's home directory to '~' for display. */
export declare function shortenHome(path: string, home?: string): string;
