import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { syncMentionAgents } from '../src/cluster/sync-agents.js';

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'codex',
  sessionId: '019f4823-74af-7510-8daa-bb7cb0450a77',
  title: '闪电说IOS 开发',
  cwd: '/Users/x/shandianshuo-iOS',
  lastActiveAt: 1000,
  ...over,
});

let dir: string;
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), 'anytoany-agents-'));
  return dir;
};
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('syncMentionAgents', () => {
  it('materializes non-claude sessions as any- prefixed agent files with exact ids', async () => {
    const agentsDir = setup();
    const { written } = await syncMentionAgents(
      [s({}), s({ agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001', title: 'x' })],
      [],
      { agentsDir },
    );
    expect(written).toHaveLength(1); // claude sessions are not materialized
    const files = readdirSync(agentsDir);
    expect(files).toEqual(['any-codex-shandianshuo-ios.md']);
    const body = readFileSync(join(agentsDir, files[0]!), 'utf8');
    expect(body).toContain('name: any-codex-shandianshuo-ios');
    expect(body).toContain('@codex:019f4823-74af-7510-8daa-bb7cb0450a77'); // pre-bound exact id
    expect(body).toContain('tools: Bash');
    expect(body).toContain('model: haiku');
  });

  it('includes device prefix for remote sessions', async () => {
    const agentsDir = setup();
    await syncMentionAgents([s({ device: 'mini', sessionId: '019f0000-0000-7000-8000-000000000001' })], [], { agentsDir });
    const files = readdirSync(agentsDir);
    expect(files).toEqual(['any-mini-codex-shandianshuo-ios.md']);
    expect(readFileSync(join(agentsDir, files[0]!), 'utf8')).toContain('@mini/codex:019f0000');
  });

  it('caps per agent kind by recency but always keeps conversation partners', async () => {
    const agentsDir = setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      s({ sessionId: `019f00${String(i).padStart(2, '0')}-0000-7000-8000-000000000001`, title: `proj${i}`, cwd: `/w/proj${i}`, lastActiveAt: i }),
    );
    const partner = many[0]!; // oldest — would be cut by the cap
    const { written } = await syncMentionAgents(
      many,
      [{ a: { agent: 'claude', sessionId: 'c1' }, b: { agent: partner.agent, sessionId: partner.sessionId } }],
      { agentsDir, maxPerAgent: 5 },
    );
    expect(written.length).toBe(6); // top 5 + 1 conversation partner
    expect(readdirSync(agentsDir).some((f) => f.includes('proj0'))).toBe(true);
  });

  it('is idempotent, removes stale any- files, never touches user files', async () => {
    const agentsDir = setup();
    writeFileSync(join(agentsDir, 'my-reviewer.md'), 'user file');
    writeFileSync(join(agentsDir, 'any-codex-gone.md'), 'stale');

    const first = await syncMentionAgents([s({})], [], { agentsDir });
    expect(first.removed).toEqual(['any-codex-gone.md']);
    const second = await syncMentionAgents([s({})], [], { agentsDir });
    expect(second.written).toHaveLength(0); // unchanged content not rewritten
    expect(readFileSync(join(agentsDir, 'my-reviewer.md'), 'utf8')).toBe('user file');
  });

  it('disambiguates name collisions with an id suffix', async () => {
    const agentsDir = setup();
    await syncMentionAgents(
      [
        s({ sessionId: '019f0001-0000-7000-8000-000000000001' }),
        s({ sessionId: '019f0002-0000-7000-8000-000000000002', lastActiveAt: 2000 }),
      ],
      [],
      { agentsDir },
    );
    const files = readdirSync(agentsDir).sort();
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });
});
