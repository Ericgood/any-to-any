import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  planSdsInstall,
  planSdsUninstall,
  removeMarkedBlock,
  resolveSdsPaths,
  upsertMarkedBlock,
} from '../src/integrations/sds.js';

/**
 * ADR-024: hooking 闪电说 up means writing three things into ITS data directory.
 * Everything here must be surgical — the user's own skills, skill toggles and
 * AGENTS.md content are not ours to touch.
 */

let appHome: string;
beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'anytoany-sds-'));
  mkdirSync(join(appHome, 'workspace'), { recursive: true });
});

const paths = () => resolveSdsPaths({ appHome });
const install = () => planSdsInstall(paths());

describe('resolveSdsPaths', () => {
  it('defaults the workspace to <appHome>/workspace', () => {
    const p = paths();
    expect(p.workspace).toBe(join(appHome, 'workspace'));
    expect(p.skillFile).toBe(join(appHome, 'workspace', 'library', 'skills', 'anytoany', 'SKILL.md'));
    expect(p.stateFile).toBe(join(appHome, 'skills', 'skills-state.json'));
    expect(p.agentsFile).toBe(join(appHome, 'workspace', 'AGENTS.md'));
  });

  // data_paths.rs:348-368 — the user can relocate the workspace, so the path
  // must never be hardcoded.
  it('honours the workspace-location migration marker', () => {
    const moved = join(appHome, 'elsewhere');
    mkdirSync(join(appHome, 'migrations'), { recursive: true });
    writeFileSync(
      join(appHome, 'migrations', 'workspace-location-v1.json'),
      JSON.stringify({ workspacePath: moved }),
      'utf8',
    );
    expect(resolveSdsPaths({ appHome }).workspace).toBe(moved);
  });

  it('falls back to the default when the marker is unreadable', () => {
    mkdirSync(join(appHome, 'migrations'), { recursive: true });
    writeFileSync(join(appHome, 'migrations', 'workspace-location-v1.json'), '{broken', 'utf8');
    expect(resolveSdsPaths({ appHome }).workspace).toBe(join(appHome, 'workspace'));
  });
});

describe('marked-block helpers (AGENTS.md)', () => {
  it('appends a fenced block to existing content, preserving it verbatim', () => {
    const before = '# 我的习惯\n\n- 用中文回我\n';
    const after = upsertMarkedBlock(before, 'HELLO');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('<!-- anytoany:begin -->');
    expect(after).toContain('HELLO');
    expect(after).toContain('<!-- anytoany:end -->');
  });

  it('replaces only the block on a second pass (idempotent)', () => {
    const once = upsertMarkedBlock('# 我的习惯\n', 'V1');
    const twice = upsertMarkedBlock(once, 'V2');
    expect(twice).toContain('V2');
    expect(twice).not.toContain('V1');
    expect(twice).toContain('# 我的习惯');
    expect(twice.match(/anytoany:begin/g)).toHaveLength(1);
    expect(upsertMarkedBlock(twice, 'V2')).toBe(twice);
  });

  it('removes only the block, leaving the user content intact', () => {
    const doc = upsertMarkedBlock('# 我的习惯\n\n- 用中文回我\n', 'OURS');
    const cleaned = removeMarkedBlock(doc);
    expect(cleaned).not.toContain('anytoany');
    expect(cleaned).toContain('- 用中文回我');
  });

  it('removing from a document without our block changes nothing', () => {
    const doc = '# 我的习惯\n';
    expect(removeMarkedBlock(doc)).toBe(doc);
  });
});

describe('planSdsInstall — dry run', () => {
  it('plans three changes and writes nothing', () => {
    const p = paths();
    const changes = install();

    expect(changes.map((c) => c.path)).toEqual([p.skillFile, p.stateFile, p.agentsFile]);
    expect(changes.every((c) => c.action === 'create')).toBe(true);
    expect(existsSync(p.skillFile)).toBe(false);
    expect(existsSync(p.stateFile)).toBe(false);
    expect(existsSync(p.agentsFile)).toBe(false);
  });

  it('the planned skill teaches the HTTP calls, not the anyd CLI', () => {
    const skill = install()[0]?.content ?? '';
    expect(skill).toMatch(/^---\nname: anytoany\n/); // frontmatter for the DSH skill loader
    expect(skill).toContain('127.0.0.1:7433/api/inbox');
    expect(skill).toContain('127.0.0.1:7433/api/send');
    expect(skill).toContain('DSH_SESSION_ID');
    expect(skill).not.toMatch(/\banyd (send|pull)\b/); // the sandbox blocks the CLI
  });

  it('reports the app as missing instead of planning writes', () => {
    expect(() => planSdsInstall(resolveSdsPaths({ appHome: join(appHome, 'nope') }))).toThrow(/闪电说|not found/i);
  });
});

describe('applyChanges — install', () => {
  it('writes all three files', () => {
    const p = paths();
    applyChanges(install());

    expect(readFileSync(p.skillFile, 'utf8')).toContain('api/inbox');
    expect(JSON.parse(readFileSync(p.stateFile, 'utf8'))).toHaveProperty('voice_assistant/anytoany');
    expect(readFileSync(p.agentsFile, 'utf8')).toContain('anytoany:begin');
  });

  // storage.rs:253-256 — a user-dropped SKILL.md is DISABLED by default. Without
  // this key the skill silently never loads.
  it('enables the skill in skills-state.json', () => {
    applyChanges(install());
    const state = JSON.parse(readFileSync(paths().stateFile, 'utf8')) as Record<string, { enabled: boolean }>;
    expect(state['voice_assistant/anytoany']?.enabled).toBe(true);
  });

  it('preserves every other key in an existing skills-state.json', () => {
    const p = paths();
    mkdirSync(join(appHome, 'skills'), { recursive: true });
    writeFileSync(
      p.stateFile,
      JSON.stringify({
        'voice_input/自动结构化': { enabled: true, created_at: 0 },
        'voice_assistant/green-tea-reply': { enabled: false, created_at: 7 },
      }),
      'utf8',
    );

    applyChanges(planSdsInstall(p));
    const state = JSON.parse(readFileSync(p.stateFile, 'utf8')) as Record<string, { enabled: boolean; created_at: number }>;
    expect(state['voice_input/自动结构化']).toEqual({ enabled: true, created_at: 0 });
    expect(state['voice_assistant/green-tea-reply']).toEqual({ enabled: false, created_at: 7 });
    expect(state['voice_assistant/anytoany']?.enabled).toBe(true);
  });

  it('preserves the user AGENTS.md content', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的习惯\n\n- 永远用中文\n', 'utf8');
    applyChanges(planSdsInstall(p));
    const after = readFileSync(p.agentsFile, 'utf8');
    expect(after).toContain('- 永远用中文');
    expect(after).toContain('anytoany:begin');
  });

  it('is idempotent — re-planning after apply reports no changes', () => {
    const p = paths();
    applyChanges(install());
    const second = planSdsInstall(p);
    expect(second.every((c) => c.action === 'unchanged')).toBe(true);

    const before = second.map((c) => readFileSync(c.path, 'utf8'));
    applyChanges(second);
    expect(second.map((c) => readFileSync(c.path, 'utf8'))).toEqual(before);
  });
});

describe('planSdsUninstall', () => {
  it('removes our skill, our state key and our AGENTS.md block — nothing else', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的习惯\n', 'utf8');
    mkdirSync(join(appHome, 'skills'), { recursive: true });
    writeFileSync(p.stateFile, JSON.stringify({ 'voice_assistant/mine': { enabled: true, created_at: 1 } }), 'utf8');
    applyChanges(planSdsInstall(p));

    applyChanges(planSdsUninstall(p));

    expect(existsSync(p.skillFile)).toBe(false);
    const state = JSON.parse(readFileSync(p.stateFile, 'utf8')) as Record<string, unknown>;
    expect(state['voice_assistant/anytoany']).toBeUndefined();
    expect(state['voice_assistant/mine']).toEqual({ enabled: true, created_at: 1 });
    const agents = readFileSync(p.agentsFile, 'utf8');
    expect(agents).toContain('# 我的习惯');
    expect(agents).not.toContain('anytoany');
  });

  it('is a no-op when nothing was installed', () => {
    const changes = planSdsUninstall(paths());
    expect(changes.every((c) => c.action === 'unchanged')).toBe(true);
    expect(() => applyChanges(changes)).not.toThrow();
  });
});
