/**
 * Root for anytoany's own state (~/.anytoany). ANYTOANY_HOME overrides it —
 * used to isolate multiple daemon instances (tests, single-machine LAN sims).
 * Agent session scanning intentionally ignores this and always uses the real home.
 */
export declare function anytoanyHome(): string;
