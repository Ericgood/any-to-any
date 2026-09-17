import type { AgentAdapter } from './types.js';
/**
 * Directory adapter for external agents (ADR-024).
 *
 * Surfaces every registered session (`~/.anytoany/registered/`) so a GUI/App
 * agent such as 闪电说 (`sds`) becomes an addressable target: `@sds:…` resolves,
 * `anyd list` shows it, and replies have somewhere to go.
 *
 * Deliberately a plain `AgentAdapter` with NO `deliver`: these sessions are
 * pull-only. The dispatcher skips them (`isPullOnly`) and they must never end
 * up in its `Map<string, DeliveryAdapter>` — see `directoryAdapters()` in cli.ts.
 */
export declare function createRegisteredAdapter(opts?: {
    home?: string;
    now?: () => number;
}): AgentAdapter;
