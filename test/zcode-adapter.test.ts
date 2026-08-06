import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createZcodeAdapter } from '../src/adapters/zcode.js';
import type { ExecFn } from '../src/adapters/types.js';

const dir = mkdtempSync(join(tmpdir(), 'anytoany-zcode-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESS = {
  agent: 'zcode',
  sessionId: 'sess_11111111-2222-4333-8444-555555555555',
  title: 'suno gateway 巡检',
  cwd: '/w/suno-gateway',
  lastActiveAt: 5000,
};

function makeDb(name: string): string {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
    directory TEXT, task_type TEXT, time_created INTEGER, time_updated INTEGER
  )`);
  const ins = db.prepare(
    'INSERT INTO session (id, parent_id, title, directory, task_type, time_created, time_updated) VALUES (?,?,?,?,?,?,?)',
  );
  ins.run(SESS.sessionId, null, SESS.title, SESS.cwd, 'interactive', 1000, 5000);
  ins.run('sess_aaaa0000-0000-4000-8000-000000000002', null, null, '/w/webapp', 'interactive', 1000, 9000);
  ins.run('sess_subagent_agent_x1', null, 'a sub agent', '/w/x', 'interactive', 0, 8);
  ins.run('sess_bbbb0000-0000-4000-8000-000000000003', SESS.sessionId, 'child of main', '/w/x', 'interactive', 0, 9);
  ins.run('sess_cccc0000-0000-4000-8000-000000000004', null, 'typed subagent', '/w/x', 'subagent_child', 0, 10);
  db.close();
  return path;
}

describe('zcode session discovery', () => {
  it('lists interactive sessions, filters all three subagent shapes, maps fields', async () => {
    const a = createZcodeAdapter({ dbFile: makeDb('db.sqlite'), engineBin: '/x/zcode.cjs' });
    const sessions = await a.listSessions();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      ['sess_aaaa0000-0000-4000-8000-000000000002', SESS.sessionId].sort(),
    );
    const main = sessions.find((s) => s.sessionId === SESS.sessionId);
    expect(main).toMatchObject({ agent: 'zcode', title: SESS.title, cwd: SESS.cwd, lastActiveAt: 5000 });
    // null title falls back to the directory basename
    const other = sessions.find((s) => s.sessionId.startsWith('sess_aaaa'));
    expect(other?.title).toBe('webapp');
    // newest first
    expect(sessions[0]?.sessionId).toBe('sess_aaaa0000-0000-4000-8000-000000000002');
  });

  it('returns [] when the db does not exist (machine without ZCode)', async () => {
    const a = createZcodeAdapter({ dbFile: join(dir, 'nope', 'db.sqlite'), engineBin: '/x/zcode.cjs' });
    expect(await a.listSessions()).toEqual([]);
  });
});

describe('zcode delivery', () => {
  const okExec: ExecFn = async () => ({ stdout: 'reply text', stderr: '', code: 0 });

  it('resumes via node with explicit non-yolo mode and the exact session id', async () => {
    const exec = vi.fn(okExec);
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/apps/zcode.cjs', exec, configFile: join(dir, 'no-config.json') });
    const r = await a.deliver(SESS, 'ENVELOPE TEXT');
    expect(r).toEqual({ ok: true, output: 'reply text' });
    expect(exec).toHaveBeenCalledWith(
      'node',
      ['/apps/zcode.cjs', '--cwd', SESS.cwd, '--resume', SESS.sessionId, '--mode', 'build', '--prompt', 'ENVELOPE TEXT'],
      { cwd: SESS.cwd, timeoutMs: 300_000 },
    );
    // headless --prompt defaults to yolo (skips permission gates) — we must never send it
    expect((exec.mock.calls[0]?.[1] ?? []).join(' ')).not.toContain('yolo');
  });

  it('runs a native binary directly and omits --cwd when unknown', async () => {
    const exec = vi.fn(okExec);
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/usr/local/bin/zcode', exec, configFile: join(dir, 'no-config.json') });
    await a.deliver({ ...SESS, cwd: '' }, 'E');
    expect(exec).toHaveBeenCalledWith(
      '/usr/local/bin/zcode',
      ['--resume', SESS.sessionId, '--mode', 'build', '--prompt', 'E'],
      { timeoutMs: 300_000 },
    );
  });

  it('surfaces the tail of stderr on failure', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: `${'x'.repeat(600)}REAL ERROR AT END`, code: 1 });
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/apps/zcode.cjs', exec, configFile: join(dir, 'no-config.json') });
    const r = await a.deliver(SESS, 'E');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REAL ERROR AT END');
    expect(r.error).toContain('exited 1');
  });
});

describe('per-machine delivery mode escalation', () => {
  const okExec: ExecFn = async () => ({ stdout: 'ok', stderr: '', code: 0 });
  const modeOf = (calls: Array<[string, string[], unknown]>) => {
    const args = calls[0]?.[1] ?? [];
    return args[args.indexOf('--mode') + 1];
  };

  it('honors the machine owner opt-in from config.json', async () => {
    const cfg = join(dir, 'config.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfg, JSON.stringify({ zcode: { deliverMode: 'yolo' } }));
    const exec = vi.fn(okExec);
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/x/zcode.cjs', exec, configFile: cfg });
    await a.deliver(SESS, 'E');
    expect(modeOf(exec.mock.calls as never)).toBe('yolo');
  });

  it('rejects unknown modes and falls back to build', async () => {
    const cfg = join(dir, 'config-bad.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfg, JSON.stringify({ zcode: { deliverMode: 'root-me-please' } }));
    const exec = vi.fn(okExec);
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/x/zcode.cjs', exec, configFile: cfg });
    await a.deliver(SESS, 'E');
    expect(modeOf(exec.mock.calls as never)).toBe('build');
  });

  it('defaults to build when no config exists', async () => {
    const exec = vi.fn(okExec);
    const a = createZcodeAdapter({ dbFile: join(dir, 'unused.sqlite'), engineBin: '/x/zcode.cjs', exec, configFile: join(dir, 'nope.json') });
    await a.deliver(SESS, 'E');
    expect(modeOf(exec.mock.calls as never)).toBe('build');
  });
});
