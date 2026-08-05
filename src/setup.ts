import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const HOOK_COMMAND = 'anyd hook claude-prompt-submit';
const CODEX_HOOK_COMMAND = 'anyd hook codex-prompt-submit';

/** Skill install targets: per-agent dirs plus the shared Agent Skills dir. */
function skillTargets(home: string): string[] {
  return [
    join(home, '.claude', 'skills', 'any-to-any'),
    join(home, '.codex', 'skills', 'any-to-any'),
    join(home, '.agents', 'skills', 'any-to-any'),
  ];
}

function installSkill(home: string): string[] {
  const source = join(dirname(require.resolve('../package.json')), 'skills', 'any-to-any', 'SKILL.md');
  const installed: string[] = [];
  for (const dir of skillTargets(home)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(source, join(dir, 'SKILL.md'));
    installed.push(dir);
  }
  return installed;
}

interface HookEntry {
  type: string;
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/**
 * Register the UserPromptSubmit hook in ~/.claude/settings.json.
 * Idempotent; writes a timestamped backup before the first modification.
 */
function installClaudeHook(home: string): 'installed' | 'already-installed' {
  const settingsPath = join(home, '.claude', 'settings.json');
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
  }

  const matchers: HookMatcher[] = settings.hooks?.['UserPromptSubmit'] ?? [];
  const present = matchers.some((m) => m.hooks.some((h) => h.command === HOOK_COMMAND));
  if (present) return 'already-installed';

  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-anytoany-${Date.now()}`);
  }
  const next: ClaudeSettings = {
    ...settings,
    hooks: {
      ...(settings.hooks ?? {}),
      UserPromptSubmit: [...matchers, { hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
    },
  };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return 'installed';
}

/**
 * Register the inbox hook in ~/.codex/hooks.json (Codex hooks are
 * format-compatible with Claude's). Idempotent, timestamped backup.
 */
function installCodexHook(home: string): 'installed' | 'already-installed' {
  const hooksPath = join(home, '.codex', 'hooks.json');
  let config: { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown } = {};
  if (existsSync(hooksPath)) {
    config = JSON.parse(readFileSync(hooksPath, 'utf8')) as typeof config;
  }
  const matchers: HookMatcher[] = config.hooks?.['UserPromptSubmit'] ?? [];
  const present = matchers.some((m) => m.hooks.some((h) => h.command === CODEX_HOOK_COMMAND));
  if (present) return 'already-installed';

  if (existsSync(hooksPath)) {
    copyFileSync(hooksPath, `${hooksPath}.bak-anytoany-${Date.now()}`);
  }
  const next = {
    ...config,
    hooks: {
      ...(config.hooks ?? {}),
      UserPromptSubmit: [...matchers, { hooks: [{ type: 'command', command: CODEX_HOOK_COMMAND }] }],
    },
  };
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return 'installed';
}

export interface SetupOptions {
  withHook: boolean;
  home?: string;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const home = opts.home ?? homedir();

  const dirs = installSkill(home);
  console.log('skill installed:');
  for (const d of dirs) console.log(`  ${d}`);

  if (opts.withHook) {
    const result = installClaudeHook(home);
    console.log(
      result === 'installed'
        ? 'claude hook registered in ~/.claude/settings.json (backup saved)'
        : 'claude hook already registered',
    );
    const codexResult = installCodexHook(home);
    console.log(
      codexResult === 'installed'
        ? 'codex hook registered in ~/.codex/hooks.json (backup saved)'
        : 'codex hook already registered',
    );
  } else {
    console.log('hooks skipped (--no-hook)');
  }

  console.log('\nnext steps:');
  console.log('  anyd start     # run the delivery daemon');
  console.log('  anyd list      # see addressable sessions');
}
