import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import type { ExecFn, SessionInfo } from '../src/adapters/types.js';
import { VERSION_MISMATCH } from '../src/adapters/version-guard.js';

const CLAUDE_ID = 'aaaa1111-0000-4000-8000-000000000001';
const CODEX_ID = '01a12d8a-cd9b-7000-8000-000000000001';
const NO_CONFIG = '/nonexistent/anytoany-config.json';

/** `--version` answers with `version`; anything else is a delivery turn. */
function versionedExec(version: string) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '--version') return { stdout: version, stderr: '', code: 0 };
    return { stdout: 'REPLY', stderr: '', code: 0 };
  };
  return { exec, calls };
}

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'claude',
  sessionId: CLAUDE_ID,
  title: 't',
  cwd: '/w/proj',
  lastActiveAt: 0,
  ...over,
});

describe('session scanners record who last wrote the session (ADR-025)', () => {
  it('claude: writerVersion is the LAST `version` in the transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyd-vg-claude-'));
    mkdirSync(join(root, '-w-proj'));
    const lines = [
      { type: 'user', cwd: '/w/proj', version: '2.1.287', message: { content: 'hello' } },
      { type: 'assistant', cwd: '/w/proj', version: '2.1.295', message: { content: [] } },
      { type: 'custom-title', customTitle: 'title' },
    ];
    writeFileSync(join(root, '-w-proj', `${CLAUDE_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
    const [s] = await createClaudeAdapter({ projectsDir: root }).listSessions();
    expect(s?.writerVersion).toBe('2.1.295');
  });

  it('codex: writerVersion is session_meta.cli_version of the newest rollout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyd-vg-codex-'));
    mkdirSync(join(root, '2026', '10', '12'), { recursive: true });
    const meta = {
      type: 'session_meta',
      payload: { id: CODEX_ID, cwd: '/w/proj', originator: 'Codex Desktop', cli_version: '0.162.0-alpha.17.2' },
    };
    writeFileSync(
      join(root, '2026', '10', '12', `rollout-2026-10-12T08-37-13-${CODEX_ID}.jsonl`),
      `${JSON.stringify(meta)}\n`,
    );
    const [s] = await createCodexAdapter({
      isThreadLive: () => false,
      sessionsDir: root,
      indexFile: join(root, 'none.jsonl'),
      configFile: NO_CONFIG,
    }).listSessions();
    expect(s?.writerVersion).toBe('0.162.0-alpha.17.2');
  });
});

// Real data (2026-10-12): a codex rollout records cli_version ONCE, at creation —
// the 3-month-old "musely 上线发布员" thread says 0.144.2 although Codex Desktop
// 0.162.0-alpha writes it every day. The live writer is inferred from the newest
// rollouts of the same originator.
describe('codex: long-lived threads inherit the version their originator runs today', () => {
  const OLD_ID = '019f5bf9-e99a-7503-8faf-eba4e9949715';
  const NEW_ID = '01a12d8a-cd9b-7000-8000-000000000002';
  const IDLE_ID = '019f0000-0000-7000-8000-000000000003';
  const TUI_ID = '01a12d00-b8c0-7000-8000-000000000004';

  function rollout(root: string, day: string, stamp: string, id: string, meta: Record<string, string>, mtime: Date) {
    const dir = join(root, ...day.split('-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-${day}T${stamp}-${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/w/p', ...meta } })}\n`);
    utimesSync(path, mtime, mtime);
  }

  it('an old Desktop thread active today is attributed to Desktop\'s current version; idle ones and other originators are not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyd-vg-codex-orig-'));
    const desktop = (v: string, ts: string) => ({ originator: 'Codex Desktop', cli_version: v, timestamp: ts });
    rollout(root, '2026-07-13', '22-55-32', OLD_ID, desktop('0.144.2', '2026-07-13T14:55:32Z'), new Date('2026-10-12T12:46:00Z'));
    rollout(root, '2026-10-12', '08-37-13', NEW_ID, desktop('0.162.0-alpha.17.2', '2026-10-12T00:37:13Z'), new Date('2026-10-12T12:00:00Z'));
    rollout(root, '2026-07-01', '10-00-00', IDLE_ID, desktop('0.140.0', '2026-07-01T02:00:00Z'), new Date('2026-07-02T00:00:00Z'));
    rollout(
      root, '2026-10-12', '06-06-24', TUI_ID,
      { originator: 'codex-tui', cli_version: '0.157.1', timestamp: '2026-10-11T22:06:24Z' },
      new Date('2026-10-12T13:00:00Z'),
    );
    const byId = new Map(
      (await createCodexAdapter({ isThreadLive: () => false, sessionsDir: root, indexFile: join(root, 'none'), configFile: NO_CONFIG }).listSessions())
        .map((s) => [s.sessionId, s.writerVersion]),
    );
    expect(byId.get(OLD_ID)).toBe('0.162.0-alpha.17.2'); // written by today's Desktop
    expect(byId.get(NEW_ID)).toBe('0.162.0-alpha.17.2');
    expect(byId.get(IDLE_ID)).toBe('0.140.0'); // untouched since July — keeps its own
    expect(byId.get(TUI_ID)).toBe('0.157.1'); // a CLI-made thread isn't held to Desktop's version
  });
});

describe('claude delivery refuses an older CLI (ADR-025)', () => {
  it('preflight reports the mismatch with the upgrade command', async () => {
    const { exec } = versionedExec('2.1.287 (Claude Code)');
    const err = await createClaudeAdapter({ exec }).preflight!(session({ writerVersion: '2.1.295' }));
    expect(err?.startsWith(VERSION_MISMATCH)).toBe(true);
    expect(err).toContain('npm i -g @anthropic-ai/claude-code@latest');
  });

  it('deliver fails terminally WITHOUT spawning the resume turn', async () => {
    const { exec, calls } = versionedExec('2.1.287 (Claude Code)');
    const r = await createClaudeAdapter({ exec }).deliver(session({ writerVersion: '2.1.295' }), 'ENV');
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
    expect(r.error?.startsWith(VERSION_MISMATCH)).toBe(true);
    expect(calls).toEqual([['claude', '--version']]);
  });

  it('a newer CLI delivers normally', async () => {
    const { exec, calls } = versionedExec('2.1.296 (Claude Code)');
    const r = await createClaudeAdapter({ exec }).deliver(session({ writerVersion: '2.1.295' }), 'ENV');
    expect(r).toEqual({ ok: true, output: 'REPLY' });
    expect(calls[1]).toEqual(['claude', '-p', '--resume', CLAUDE_ID, 'ENV']);
  });
});

describe('codex delivery refuses an older CLI (ADR-025)', () => {
  const codex = (over: Partial<SessionInfo>) => session({ agent: 'codex', sessionId: CODEX_ID, ...over });

  it('deliver fails terminally WITHOUT spawning codex exec resume', async () => {
    const { exec, calls } = versionedExec('codex-cli 0.157.1');
    const r = await createCodexAdapter({ isThreadLive: () => false, exec, configFile: NO_CONFIG }).deliver(
      codex({ writerVersion: '0.162.0-alpha.17.2' }),
      'ENV',
    );
    expect(r.ok).toBe(false);
    expect(r.retry).toBe(false);
    expect(r.error).toContain('0.157.1');
    expect(r.error).toContain('npm i -g @openai/codex@latest');
    expect(calls).toEqual([['codex', '--version']]);
  });

  it('the npm `latest` (0.162.1) resumes a 0.162.0-alpha session', async () => {
    const { exec } = versionedExec('codex-cli 0.162.1');
    const r = await createCodexAdapter({ isThreadLive: () => false, exec, configFile: NO_CONFIG }).deliver(
      codex({ writerVersion: '0.162.0-alpha.17.2' }),
      'ENV',
    );
    expect(r.ok).toBe(true);
  });
});
