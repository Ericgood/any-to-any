import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createKimiAdapter } from '../src/adapters/kimi.js';
import type { ExecFn } from '../src/adapters/types.js';

const dir = mkdtempSync(join(tmpdir(), 'anytoany-kimi-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESS = {
  agent: 'kimi',
  sessionId: 'session_11111111-1111-4111-8111-111111111111',
  title: 'suno-gateway',
  cwd: '/Users/gongzhen/suno-gateway',
  lastActiveAt: 0,
};

/** Build a session_index.jsonl + on-disk session dirs with set mtimes. */
function makeIndex(name: string, rows: Array<{ id: string; workDir: string; mtime: number }>): string {
  const idx = join(dir, name);
  const lines: string[] = [];
  for (const r of rows) {
    const sessionDir = join(dir, name + '-sessions', r.id);
    mkdirSync(sessionDir, { recursive: true });
    utimesSync(sessionDir, r.mtime / 1000, r.mtime / 1000);
    lines.push(JSON.stringify({ sessionId: r.id, sessionDir, workDir: r.workDir }));
  }
  writeFileSync(idx, lines.join('\n') + '\n');
  return idx;
}

describe('kimi session discovery', () => {
  it('maps sessionId/workDir, titles from workDir basename, sorts by dir mtime desc', async () => {
    const idx = makeIndex('idx1', [
      { id: 'session_aaaa', workDir: '/Users/gongzhen/suno-gateway', mtime: 5000 },
      { id: 'session_bbbb', workDir: '/Users/gongzhen/wechot', mtime: 9000 },
    ]);
    const a = createKimiAdapter({ indexFile: idx, kimiBin: '/x/kimi' });
    const s = await a.listSessions();
    expect(s.map((x) => x.sessionId)).toEqual(['session_bbbb', 'session_aaaa']); // newest first
    const g = s.find((x) => x.sessionId === 'session_aaaa');
    expect(g).toMatchObject({ agent: 'kimi', title: 'suno-gateway', cwd: '/Users/gongzhen/suno-gateway', lastActiveAt: 5000 });
  });

  it('returns [] when the index does not exist (machine without kimi)', async () => {
    const a = createKimiAdapter({ indexFile: join(dir, 'nope.jsonl'), kimiBin: '/x/kimi' });
    expect(await a.listSessions()).toEqual([]);
  });

  it('skips malformed index lines without failing the whole scan', async () => {
    const idx = join(dir, 'idx-bad.jsonl');
    writeFileSync(idx, `not json\n${JSON.stringify({ sessionId: 'session_ok', sessionDir: join(dir, 'x'), workDir: '/w/ok' })}\n`);
    const a = createKimiAdapter({ indexFile: idx, kimiBin: '/x/kimi' });
    const s = await a.listSessions();
    expect(s).toHaveLength(1);
    expect(s[0]?.sessionId).toBe('session_ok');
  });
});

describe('kimi delivery', () => {
  // Real stream-json shape (verified on kimi 0.32.0): empty assistant, tool result,
  // final assistant WITH the reply text, then a meta resume_hint to ignore.
  const streamOut = [
    JSON.stringify({ role: 'assistant', content: '' }),
    JSON.stringify({ role: 'tool', content: 'Wrote 1 bytes to x.txt' }),
    JSON.stringify({ role: 'assistant', content: '<<<ANYTOANY_REPLY>>> DONE did the thing' }),
    JSON.stringify({ role: 'meta', type: 'session.resume_hint', content: 'To resume: kimi -r session_11111111' }),
  ].join('\n');

  it('resumes by id with stream-json and NEVER passes -y/--auto (both rejected with -p)', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: streamOut, stderr: '', code: 0 }));
    const a = createKimiAdapter({ indexFile: join(dir, 'unused'), kimiBin: '/usr/local/bin/kimi', exec });
    const r = await a.deliver(SESS, 'ENVELOPE');
    expect(exec).toHaveBeenCalledWith(
      '/usr/local/bin/kimi',
      ['-S', SESS.sessionId, '-p', 'ENVELOPE', '--output-format', 'stream-json'],
      { cwd: SESS.cwd, timeoutMs: 300_000 },
    );
    const argv = (exec.mock.calls[0]?.[1] ?? []).join(' ');
    expect(argv).not.toMatch(/-y|--yolo|--auto/);
    // reply = concatenated assistant text only; tool + meta(resume hint) excluded
    expect(r.ok).toBe(true);
    expect(r.output).toBe('<<<ANYTOANY_REPLY>>> DONE did the thing');
    expect(r.output).not.toContain('To resume');
    expect(r.output).not.toContain('Wrote 1 bytes');
  });

  it('omits cwd when unknown', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: streamOut, stderr: '', code: 0 }));
    const a = createKimiAdapter({ indexFile: join(dir, 'unused'), kimiBin: '/usr/local/bin/kimi', exec });
    await a.deliver({ ...SESS, cwd: '' }, 'E');
    expect(exec).toHaveBeenCalledWith('/usr/local/bin/kimi', expect.any(Array), { timeoutMs: 300_000 });
  });

  it('surfaces the tail of stderr on failure', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: `${'x'.repeat(600)}REAL KIMI ERROR`, code: 1 });
    const a = createKimiAdapter({ indexFile: join(dir, 'unused'), kimiBin: '/usr/local/bin/kimi', exec });
    const r = await a.deliver(SESS, 'E');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REAL KIMI ERROR');
    expect(r.error).toContain('exited 1');
  });
});
