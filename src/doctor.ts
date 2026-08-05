import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realExec } from './adapters/exec.js';
import { defaultDbPath, createDb } from './mailbox/db.js';

interface Check {
  name: string;
  ok: boolean;
  note: string;
}

async function which(cmd: string): Promise<string | null> {
  const { stdout, code } = await realExec('which', [cmd], { timeoutMs: 5000 });
  return code === 0 ? stdout.trim() : null;
}

export async function runDoctor(): Promise<boolean> {
  const home = homedir();
  const checks: Check[] = [];

  const claudeBin = await which('claude');
  checks.push({
    name: 'claude CLI',
    ok: claudeBin !== null,
    note: claudeBin ?? 'not found — claude sessions cannot be delivered to',
  });
  const codexBin = await which('codex');
  checks.push({
    name: 'codex CLI',
    ok: codexBin !== null,
    note: codexBin ?? 'not found — codex sessions cannot be delivered to',
  });

  checks.push({
    name: 'claude sessions',
    ok: existsSync(join(home, '.claude', 'projects')),
    note: '~/.claude/projects',
  });
  checks.push({
    name: 'codex sessions',
    ok: existsSync(join(home, '.codex', 'sessions')),
    note: '~/.codex/sessions',
  });
  checks.push({
    name: 'codex auth (file-based, auto-delivery ready)',
    ok: existsSync(join(home, '.codex', 'auth.json')),
    note: '~/.codex/auth.json',
  });

  try {
    createDb(defaultDbPath()).prepare('SELECT 1').get();
    checks.push({ name: 'mailbox db', ok: true, note: defaultDbPath() });
  } catch (e) {
    checks.push({ name: 'mailbox db', ok: false, note: e instanceof Error ? e.message : String(e) });
  }

  const skillInstalled = existsSync(join(home, '.claude', 'skills', 'any-to-any', 'SKILL.md'));
  checks.push({
    name: 'skill installed',
    ok: skillInstalled,
    note: skillInstalled ? '~/.claude/skills/any-to-any' : 'run: anyd setup',
  });

  let hookRegistered = false;
  try {
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    hookRegistered =
      settings.hooks?.['UserPromptSubmit']?.some((m) =>
        m.hooks.some((h) => h.command.includes('anyd hook claude-prompt-submit')),
      ) ?? false;
  } catch {
    /* missing settings file — hook not registered */
  }
  checks.push({
    name: 'claude inbox hook',
    ok: hookRegistered,
    note: hookRegistered ? 'UserPromptSubmit registered' : 'run: anyd setup',
  });

  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`);
  }
  console.log(
    `\nnote: claude CLI login state cannot be checked offline; if deliveries fail with "Not logged in", run \`claude\` once to log in (see ADR-008).`,
  );
  return allOk;
}
