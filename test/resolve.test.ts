import { describe, expect, it } from 'vitest';
import { parseTarget, resolveTarget } from '../src/directory/resolve.js';
import type { SessionInfo } from '../src/adapters/types.js';

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000000',
  title: 'untitled',
  cwd: '/tmp/proj',
  lastActiveAt: 1000,
  ...over,
});

const SESSIONS: SessionInfo[] = [
  s({ agent: 'claude', sessionId: 'abc11111-0000-4000-8000-000000000001', title: '后端重构', cwd: '/w/backend', lastActiveAt: 3000 }),
  s({ agent: 'claude', sessionId: 'def22222-0000-4000-8000-000000000002', title: 'SEO 页面批量生成', cwd: '/w/soundwise', lastActiveAt: 5000 }),
  s({ agent: 'codex', sessionId: 'abc33333-0000-4000-8000-000000000003', title: '前端重构', cwd: '/w/frontend', lastActiveAt: 4000 }),
  s({ agent: 'codex', sessionId: 'fff44444-0000-4000-8000-000000000004', title: 'abc pipeline debug', cwd: '/w/pipeline', lastActiveAt: 2000 }),
];

describe('parseTarget', () => {
  it('parses @agent', () => {
    expect(parseTarget('@codex')).toEqual({ agent: 'codex' });
  });
  it('parses @agent:fragment', () => {
    expect(parseTarget('@codex:前端')).toEqual({ agent: 'codex', fragment: '前端' });
  });
  it('parses @device/agent:fragment', () => {
    expect(parseTarget('@mini/codex:x')).toEqual({ device: 'mini', agent: 'codex', fragment: 'x' });
  });
  it('normalizes agent name case', () => {
    expect(parseTarget('@Codex:X')).toEqual({ agent: 'codex', fragment: 'X' });
  });
  it('rejects garbage', () => {
    expect(parseTarget('codex')).toBeNull();
    expect(parseTarget('@')).toBeNull();
    expect(parseTarget('@:x')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });
});

describe('resolveTarget', () => {
  it('no fragment → most recently active session of that agent', () => {
    const r = resolveTarget('@claude', SESSIONS);
    expect(r.ok && r.session.sessionId).toBe('def22222-0000-4000-8000-000000000002');
  });

  it('matches by session id prefix', () => {
    const r = resolveTarget('@codex:fff4', SESSIONS);
    expect(r.ok && r.session.title).toBe('abc pipeline debug');
  });

  it('id prefix beats title substring', () => {
    // "abc" is both an id prefix of one codex session and a title substring of another
    const r = resolveTarget('@codex:abc', SESSIONS);
    expect(r.ok && r.session.sessionId).toBe('abc33333-0000-4000-8000-000000000003');
  });

  it('matches by title substring, case-insensitive', () => {
    const r = resolveTarget('@claude:seo', SESSIONS);
    expect(r.ok && r.session.title).toBe('SEO 页面批量生成');
  });

  it('matches by cwd basename substring', () => {
    const r = resolveTarget('@codex:pipel', SESSIONS);
    expect(r.ok && r.session.cwd).toBe('/w/pipeline');
  });

  it('ambiguous → candidates sorted by recency', () => {
    const r = resolveTarget('@claude:重构', [
      ...SESSIONS,
      s({ agent: 'claude', sessionId: 'eee55555-0000-4000-8000-000000000005', title: '数据库重构', lastActiveAt: 9000 }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.candidates.map((c) => c.sessionId)).toEqual([
        'eee55555-0000-4000-8000-000000000005',
        'abc11111-0000-4000-8000-000000000001',
      ]);
    }
  });

  it('no match → not_found with agent sessions as candidates', () => {
    const r = resolveTarget('@codex:nonexistent', SESSIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_found');
      expect(r.candidates).toHaveLength(2);
      expect(r.candidates[0]?.title).toBe('前端重构'); // most recent codex first
    }
  });

  it('unknown agent → not_found with empty candidates', () => {
    const r = resolveTarget('@kimi:x', SESSIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_found');
      expect(r.candidates).toHaveLength(0);
    }
  });

  it('device segment → unsupported_device in Phase 1', () => {
    const r = resolveTarget('@mini/codex:x', SESSIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_device');
  });

  it('invalid syntax → invalid_target', () => {
    const r = resolveTarget('not-a-target', SESSIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_target');
  });
});
