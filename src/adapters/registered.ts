import { listRegistered } from '../registry/external.js';
import type { AgentAdapter, SessionInfo } from './types.js';

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
export function createRegisteredAdapter(
  opts: { home?: string; now?: () => number } = {},
): AgentAdapter {
  return {
    // Only used to attribute a scan failure in `listAllSessions`; addressing uses
    // each session's own `agent` field, which is whatever the app registered as.
    agent: 'external',
    listSessions: async (): Promise<SessionInfo[]> =>
      listRegistered(opts).map((s) => ({
        agent: s.agent,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        lastActiveAt: s.lastSeenAt,
      })),
  };
}
