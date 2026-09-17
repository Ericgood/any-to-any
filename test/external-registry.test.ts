import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RESERVED_AGENT_NAMES,
  isRegisteredSession,
  listRegistered,
  register,
  unregister,
} from '../src/registry/external.js';

/**
 * Phase 5 / ADR-024: an "external agent" is a GUI/App agent anytoany has no
 * delivery adapter for (first one: 闪电说 / `sds`). It registers itself so it
 * becomes an addressable first-class target, then PULLS its own mail.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'anytoany-registry-'));
});

const sds = (over: Record<string, unknown> = {}) => ({
  agent: 'sds',
  sessionId: 'shandianshuo-abc123',
  title: '闪电说助手',
  cwd: '/Users/me/Library/Application Support/Shandianshuo/workspace',
  ...over,
});

describe('external agent registry', () => {
  it('registers a session and lists it back', () => {
    const s = register(sds(), { home, now: () => 1_000 });
    expect(s).toMatchObject({ agent: 'sds', sessionId: 'shandianshuo-abc123', title: '闪电说助手' });
    expect(s.registeredAt).toBe(1_000);
    expect(s.lastSeenAt).toBe(1_000);

    const all = listRegistered({ home, now: () => 1_000 });
    expect(all).toHaveLength(1);
    expect(all[0]?.sessionId).toBe('shandianshuo-abc123');
  });

  it('re-registering is an upsert — one row, refreshed lastSeenAt, original registeredAt', () => {
    register(sds(), { home, now: () => 1_000 });
    const again = register(sds({ title: '改了名' }), { home, now: () => 5_000 });

    expect(again.registeredAt).toBe(1_000); // birth time is preserved
    expect(again.lastSeenAt).toBe(5_000);
    expect(again.title).toBe('改了名');

    const all = listRegistered({ home, now: () => 5_000 });
    expect(all).toHaveLength(1);
    expect(readdirSync(join(home, '.anytoany', 'registered'))).toHaveLength(1);
  });

  // The heartbeat call an external agent makes every turn may carry only
  // {agent, sessionId}. It must refresh lastSeenAt without wiping the identity
  // the first, fuller registration established.
  it('an upsert without title/cwd keeps the previously registered ones', () => {
    register(sds(), { home, now: () => 1_000 });
    const beat = register({ agent: 'sds', sessionId: 'shandianshuo-abc123' }, { home, now: () => 2_000 });

    expect(beat.title).toBe('闪电说助手');
    expect(beat.cwd).toBe('/Users/me/Library/Application Support/Shandianshuo/workspace');
    expect(beat.lastSeenAt).toBe(2_000);
  });

  it('does not mutate its input (immutable style)', () => {
    const input = sds();
    const frozen = JSON.stringify(input);
    register(input, { home, now: () => 1_000 });
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('unregisters, and unregistering twice is silently idempotent', () => {
    register(sds(), { home });
    unregister('sds', 'shandianshuo-abc123', { home });
    expect(listRegistered({ home })).toHaveLength(0);
    expect(() => unregister('sds', 'shandianshuo-abc123', { home })).not.toThrow();
  });

  // A registration is a long-lived identity (not monitor.ts's 10s liveness
  // heartbeat), but an uninstalled app must not own `@sds` forever.
  it('hides entries older than the TTL, but keeps the file so re-registering revives it', () => {
    register(sds(), { home, now: () => 0 });
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    expect(listRegistered({ home, now: () => weekMs + 1 })).toHaveLength(0);
    expect(listRegistered({ home, now: () => weekMs + 1, includeStale: true })).toHaveLength(1);

    const revived = register(sds(), { home, now: () => weekMs + 2 });
    expect(revived.registeredAt).toBe(0); // same identity, not a new one
    expect(listRegistered({ home, now: () => weekMs + 2 })).toHaveLength(1);
  });

  it('rejects reserved agent names — they would collide with real delivery adapters', () => {
    for (const name of RESERVED_AGENT_NAMES) {
      expect(() => register(sds({ agent: name }), { home })).toThrow(/reserved/i);
    }
    expect(RESERVED_AGENT_NAMES).toContain('user');
    expect(RESERVED_AGENT_NAMES).toContain('claude');
  });

  it('rejects malformed agent names and empty session ids', () => {
    for (const bad of ['S', 'Sds', 'sd s', '9sds', 'sds!', '', 'a'.repeat(33)]) {
      expect(() => register(sds({ agent: bad }), { home })).toThrow();
    }
    expect(() => register(sds({ sessionId: '' }), { home })).toThrow(/session/i);
    expect(() => register(sds({ sessionId: '   ' }), { home })).toThrow(/session/i);
  });

  it('keeps session ids with path-hostile characters addressable', () => {
    const s = register(sds({ sessionId: 'a/b c:d' }), { home, now: () => 1 });
    expect(s.sessionId).toBe('a/b c:d'); // stored verbatim…
    const files = readdirSync(join(home, '.anytoany', 'registered'));
    expect(files[0]).not.toContain('/'); // …but the filename is sanitised
    expect(listRegistered({ home, now: () => 1 })[0]?.sessionId).toBe('a/b c:d');
  });

  it('defaults title to the agent name and cwd to empty', () => {
    const s = register({ agent: 'sds', sessionId: 'x1' }, { home, now: () => 1 });
    expect(s.title).toBe('sds');
    expect(s.cwd).toBe('');
  });

  it('survives a missing directory and a corrupt file without failing the whole scan', () => {
    expect(listRegistered({ home })).toEqual([]);

    register(sds(), { home, now: () => 1 });
    const dir = join(home, '.anytoany', 'registered');
    writeFileSync(join(dir, 'broken.json'), '{not json', 'utf8');
    mkdirSync(join(dir, 'a-directory.json'));

    const all = listRegistered({ home, now: () => 1 });
    expect(all).toHaveLength(1);
    expect(all[0]?.agent).toBe('sds');
  });

  it('sorts most-recently-seen first', () => {
    register({ agent: 'sds', sessionId: 'old' }, { home, now: () => 1_000 });
    register({ agent: 'sds', sessionId: 'new' }, { home, now: () => 9_000 });
    expect(listRegistered({ home, now: () => 9_000 }).map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('isRegisteredSession — the dispatcher pull-only check', () => {
  it('is true for a registered session id and false otherwise', () => {
    register(sds(), { home, now: () => 1 });
    expect(isRegisteredSession('shandianshuo-abc123', { home })).toBe(true);
    expect(isRegisteredSession('some-claude-uuid', { home })).toBe(false);
  });

  // The dispatcher's skip callback only receives a sessionId — no agent. A stale
  // registration must STILL be skipped: headless-resuming it is impossible either
  // way, and dead-lettering the message would just lose it.
  it('stays true past the TTL — a stale external session must never be resume-delivered', () => {
    register(sds(), { home, now: () => 0 });
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    expect(listRegistered({ home, now: () => weekMs + 1 })).toHaveLength(0);
    expect(isRegisteredSession('shandianshuo-abc123', { home, now: () => weekMs + 1 })).toBe(true);
  });

  it('is false when nothing was ever registered', () => {
    expect(isRegisteredSession('anything', { home })).toBe(false);
  });
});
