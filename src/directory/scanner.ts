import type { AgentAdapter, SessionInfo } from '../adapters/types.js';

export interface ScanError {
  agent: string;
  error: Error;
}

export interface ScanResult {
  /** All discovered sessions, most recently active first. */
  sessions: SessionInfo[];
  /** Per-adapter failures; one broken adapter must not break the directory. */
  errors: ScanError[];
}

export async function listAllSessions(adapters: AgentAdapter[]): Promise<ScanResult> {
  const settled = await Promise.allSettled(adapters.map((a) => a.listSessions()));

  const sessions: SessionInfo[] = [];
  const errors: ScanError[] = [];
  settled.forEach((result, i) => {
    const adapter = adapters[i];
    if (!adapter) return;
    if (result.status === 'fulfilled') {
      sessions.push(...result.value);
    } else {
      const cause = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      errors.push({ agent: adapter.agent, error: cause });
    }
  });

  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return { sessions, errors };
}
