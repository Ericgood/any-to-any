import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import { listAllSessions } from '../src/directory/scanner.js';
import type { AgentAdapter } from '../src/adapters/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('claude adapter listSessions', () => {
  const adapter = createClaudeAdapter({ projectsDir: join(FIXTURES, 'claude-projects') });

  it('discovers sessions and reads cwd from content, not from escaped dir name', async () => {
    const sessions = await adapter.listSessions();
    const a = sessions.find((x) => x.sessionId === '11111111-1111-4111-8111-111111111111');
    expect(a).toBeDefined();
    expect(a?.cwd).toBe('/tmp/real-proj-a'); // dir name says -tmp-fake-escaped-a
    expect(a?.agent).toBe('claude');
  });

  it('uses the LAST custom-title as title', async () => {
    const sessions = await adapter.listSessions();
    const a = sessions.find((x) => x.sessionId === '11111111-1111-4111-8111-111111111111');
    expect(a?.title).toBe('backend refactor');
  });

  it('falls back to first user text when no custom-title, string content form', async () => {
    const sessions = await adapter.listSessions();
    const b = sessions.find((x) => x.sessionId === 'aaaaaaaa-2222-4222-8222-222222222222');
    expect(b?.title).toBe('quick question about vitest coverage setup');
  });

  it('ignores non-session files (memory dir, non-uuid names)', async () => {
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
  });
});

describe('codex adapter listSessions', () => {
  const adapter = createCodexAdapter({
    sessionsDir: join(FIXTURES, 'codex-sessions'),
    indexFile: join(FIXTURES, 'codex-session_index.jsonl'),
  });

  it('discovers rollout files, reads cwd from session_meta, title from index', async () => {
    const sessions = await adapter.listSessions();
    const a = sessions.find((x) => x.sessionId === '33333333-3333-4333-8333-333333333333');
    expect(a).toBeDefined();
    expect(a?.cwd).toBe('/tmp/codex-proj-frontend');
    expect(a?.title).toBe('frontend refactor');
    expect(a?.agent).toBe('codex');
  });

  it('falls back to cwd basename when thread not in index; index-only ghosts excluded', async () => {
    const sessions = await adapter.listSessions();
    const orphan = sessions.find((x) => x.sessionId === '44444444-4444-4444-8444-444444444444');
    expect(orphan?.title).toBe('codex-proj-orphan');
    expect(sessions).toHaveLength(3); // ghost 9999… from index must not appear
  });

  it('a thread whose NEWEST rollout lacks session metadata is unresumable — excluded (dead-door)', async () => {
    const sessions = await adapter.listSessions();
    expect(sessions.find((x) => x.sessionId === '66666666-6666-4666-8666-666666666666')).toBeUndefined();
  });

  it('multi-rollout threads appear exactly once, keyed off the newest rollout', async () => {
    const sessions = await adapter.listSessions();
    const dual = sessions.filter((x) => x.sessionId === '77777777-7777-4777-8777-777777777777');
    expect(dual).toHaveLength(1);
    expect(dual[0]?.cwd).toBe('/tmp/codex-proj-dual');
  });

  it('excludes multi-agent sub-agent threads (they reject direct input)', async () => {
    const sessions = await adapter.listSessions();
    expect(sessions.find((x) => x.sessionId === '55555555-5555-4555-8555-555555555555')).toBeUndefined();
  });

  it('lastActiveAt trusts the newer of index updated_at and file mtime (stale-index bug)', async () => {
    const sessions = await adapter.listSessions();
    const indexed = sessions.find((x) => x.sessionId === '33333333-3333-4333-8333-333333333333');
    // fixture index says 2026-08-05T12:00Z but the file mtime (checkout time) is newer — mtime must win
    expect(indexed?.lastActiveAt).toBeGreaterThanOrEqual(Date.parse('2026-08-05T12:00:00.000Z'));
  });
});

describe('listAllSessions aggregation', () => {
  it('merges adapters and survives a failing adapter', async () => {
    const good = createClaudeAdapter({ projectsDir: join(FIXTURES, 'claude-projects') });
    const bad: AgentAdapter = {
      agent: 'broken',
      listSessions: async () => {
        throw new Error('boom');
      },
    };
    const { sessions, errors } = await listAllSessions([good, bad]);
    expect(sessions).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.agent).toBe('broken');
  });
});
