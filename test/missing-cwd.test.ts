import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import { realExec } from '../src/adapters/exec.js';
import type { ExecFn, SessionInfo } from '../src/adapters/types.js';

// 2026-10-25 incident: a Codex thread was created in ~/增长研究/clonecut, then the
// project moved to ~/clonecut. Delivering to it spawned `codex` with the old,
// deleted folder as cwd — Node reports that as "spawn codex ENOENT", so it looked
// like Codex wasn't installed. 3 retries, dead letter, and the sender waited 29 min.
const GONE = '/Users/nobody/增长研究/clonecut-moved-away';

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'codex',
  sessionId: '01a13a72-0000-7000-8000-000000000001',
  title: 't',
  cwd: GONE,
  lastActiveAt: 0,
  ...over,
});

function recordingExec() {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    return { stdout: 'Queued message x for thread y. <<<ANYTOANY_REPLY>>> DONE', stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('a session whose project folder was moved or deleted', () => {
  it('realExec says the FOLDER is missing — not the misleading "spawn <cmd> ENOENT"', async () => {
    const r = await realExec('node', ['-v'], { cwd: GONE, timeoutMs: 5000 });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('working directory does not exist');
    expect(r.stderr).toContain(GONE);
  });

  it('codex (queue and resume are cwd-independent) still delivers, just without the stale cwd', async () => {
    for (const live of [true, false]) {
      const { exec, calls } = recordingExec();
      const adapter = createCodexAdapter({ exec, configFile: '/nonexistent/c.json', isThreadLive: () => live });
      const r = await adapter.deliver(session({}), 'ENVELOPE');
      expect(r.ok).toBe(true);
      expect(calls[0]?.cwd).toBeUndefined();
    }
  });

  it('claude (resume needs the project dir) fails at once, terminally, saying why', async () => {
    const { exec, calls } = recordingExec();
    const r = await createClaudeAdapter({ exec }).deliver(session({ agent: 'claude' }), 'ENVELOPE');
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
    expect(r.error).toContain(GONE);
    expect(r.error).toMatch(/moved or deleted/);
    expect(calls).toEqual([]);
  });
});
