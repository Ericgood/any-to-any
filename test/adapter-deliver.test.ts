import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import type { ExecFn, SessionInfo } from '../src/adapters/types.js';

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'codex',
  sessionId: '33333333-3333-4333-8333-333333333333',
  title: 't',
  cwd: '/w/proj',
  lastActiveAt: 0,
  ...over,
});

function mockExec(result: { stdout?: string; stderr?: string; code?: number }) {
  const calls: Array<{ cmd: string; args: string[]; opts: { cwd?: string; timeoutMs: number } }> = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
  };
  return { exec, calls };
}

describe('codex deliver contract', () => {
  it('spawns codex exec resume with argv-passed envelope (no shell)', async () => {
    const { exec, calls } = mockExec({ stdout: 'BRAVO' });
    const adapter = createCodexAdapter({ exec, configFile: '/nonexistent/anytoany-config.json' });
    const r = await adapter.deliver(session({}), 'ENVELOPE "quoted; $(rm -rf)"');
    expect(r).toEqual({ ok: true, output: 'BRAVO' });
    expect(calls[0]?.cmd).toBe('codex');
    expect(calls[0]?.args).toEqual([
      'exec',
      'resume',
      '33333333-3333-4333-8333-333333333333',
      '--skip-git-repo-check',
      'ENVELOPE "quoted; $(rm -rf)"',
    ]);
  });

  it('reports non-zero exit as failure with stderr', async () => {
    const { exec } = mockExec({ code: 2, stderr: 'thread not found' });
    const adapter = createCodexAdapter({ exec, configFile: '/nonexistent/anytoany-config.json' });
    const r = await adapter.deliver(session({}), 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('thread not found');
  });
});

describe('claude deliver contract', () => {
  it('runs claude -p --resume from the session cwd', async () => {
    const { exec, calls } = mockExec({ stdout: 'ok' });
    const adapter = createClaudeAdapter({ exec });
    const r = await adapter.deliver(
      session({ agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001', cwd: '/w/backend' }),
      'ENV',
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.cmd).toBe('claude');
    expect(calls[0]?.args).toEqual(['-p', '--resume', 'aaaa1111-0000-4000-8000-000000000001', 'ENV']);
    expect(calls[0]?.opts.cwd).toBe('/w/backend');
  });

  it('fails fast when session cwd is unknown', async () => {
    const { exec, calls } = mockExec({});
    const adapter = createClaudeAdapter({ exec });
    const r = await adapter.deliver(session({ agent: 'claude', cwd: '' }), 'ENV');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cwd/);
    expect(calls).toHaveLength(0);
  });

  it('maps "Not logged in" stdout to a login-hint failure', async () => {
    const { exec } = mockExec({ stdout: '{"result":"Not logged in · Please run /login"}' });
    const adapter = createClaudeAdapter({ exec });
    const r = await adapter.deliver(session({ agent: 'claude' }), 'ENV');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not logged in/i);
  });
});

describe('codex per-machine sandbox escalation', () => {
  it('adds --sandbox only when the machine owner opted in via config.json', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'anytoany-codexcfg-'));
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ codex: { sandbox: 'danger-full-access' } }));

    const calls: string[][] = [];
    const exec = async (_c: string, args: string[]) => {
      calls.push(args);
      return { stdout: 'ok', stderr: '', code: 0 };
    };
    const session = { agent: 'codex', sessionId: 'x-1', title: 't', cwd: '/w', lastActiveAt: 0 };

    const withCfg = createCodexAdapter({ exec, configFile: cfg });
    await withCfg.deliver(session, 'E');
    // --sandbox MUST precede the `resume` subcommand (it's an `exec` flag)
    expect(calls[0]).toEqual(['exec', '--sandbox', 'danger-full-access', 'resume', 'x-1', '--skip-git-repo-check', 'E']);

    writeFileSync(cfg, JSON.stringify({ codex: { sandbox: 'sudo-everything' } })); // unknown → no flag
    await withCfg.deliver(session, 'E');
    expect(calls[1]).toEqual(['exec', 'resume', 'x-1', '--skip-git-repo-check', 'E']);

    const noCfg = createCodexAdapter({ exec, configFile: join(dir, 'none.json') });
    await noCfg.deliver(session, 'E');
    expect(calls[2]).toEqual(['exec', 'resume', 'x-1', '--skip-git-repo-check', 'E']);
  });
});
