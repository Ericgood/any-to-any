import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runSetup } from '../src/setup.js';
import { readPid, writePid, clearPid, isAlive } from '../src/daemon/pidfile.js';

const home = mkdtempSync(join(tmpdir(), 'anytoany-setup-'));

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('runSetup', () => {
  it('installs the skill into all three agent skill dirs', async () => {
    await runSetup({ withHook: false, home });
    for (const dir of ['.claude', '.codex', '.agents']) {
      const p = join(home, dir, 'skills', 'any-to-any', 'SKILL.md');
      expect(existsSync(p), p).toBe(true);
      expect(readFileSync(p, 'utf8')).toContain('name: any-to-any');
    }
  });

  it('registers the claude hook idempotently and preserves existing settings', async () => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));

    await runSetup({ withHook: true, home });
    const first = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(first.model).toBe('opus'); // untouched
    expect(first.hooks['Stop']).toHaveLength(1); // untouched
    expect(first.hooks['UserPromptSubmit']?.some((m) => m.hooks.some((h) => h.command.includes('anyd hook')))).toBe(true);

    await runSetup({ withHook: true, home }); // second run must not duplicate
    const second = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof first;
    expect(second.hooks['UserPromptSubmit']).toHaveLength(1);
  });
});

describe('pidfile', () => {
  it('write/read/clear round-trip and liveness', () => {
    writePid(process.pid);
    expect(readPid()).toBe(process.pid);
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999999)).toBe(false);
    clearPid();
    expect(readPid()).toBeNull();
  });
});
