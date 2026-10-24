import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { resolveSelfSessions } from '../src/directory/self.js';

// 2026-10-24 incident: a Codex thread sent a hand-off to the Claude session open in
// the SAME folder, then ran `anyd pull --quiet` as the skill suggests. pull matched
// "every session whose cwd is this folder" — so it took the Claude session's mail,
// marked it delivered, and printed it into Codex's own output. Claude never got it.
const IOS = '/Users/gongzhen/shandianshuo-iOS';
const CLAUDE: SessionInfo = { agent: 'claude', sessionId: 'e5f3e388-036f-4538-a9d5-f1de26dc9e7f', title: 'iPad 页面卡住问题', cwd: IOS, lastActiveAt: 2 };
const CODEX: SessionInfo = { agent: 'codex', sessionId: '01a15581-6cb9-74b2-956d-507a2da28ec7', title: '闪电说 iOS 开发（当前）', cwd: IOS, lastActiveAt: 1 };
const ELSEWHERE: SessionInfo = { agent: 'kimi', sessionId: 'k1', title: 'x', cwd: '/other', lastActiveAt: 3 };
const DIR = [CLAUDE, CODEX, ELSEWHERE];

describe('which session is "me" when anyd pull / monitor gets no --session', () => {
  it('inside Codex: CODEX_THREAD_ID wins — never the Claude session in the same folder', () => {
    const r = resolveSelfSessions(DIR, IOS, { CODEX_THREAD_ID: CODEX.sessionId });
    expect(r).toEqual({ ok: true, targets: [{ id: CODEX.sessionId, label: '@codex:闪电说 iOS 开发（当前）' }] });
  });

  it('inside Claude Code: CLAUDE_CODE_SESSION_ID wins', () => {
    const r = resolveSelfSessions(DIR, IOS, { CLAUDE_CODE_SESSION_ID: CLAUDE.sessionId });
    expect(r).toEqual({ ok: true, targets: [{ id: CLAUDE.sessionId, label: '@claude:iPad 页面卡住问题' }] });
  });

  it('identity from env works even before the directory scan has the session', () => {
    const r = resolveSelfSessions([], IOS, { CODEX_THREAD_ID: 'brand-new-thread' });
    expect(r).toEqual({ ok: true, targets: [{ id: 'brand-new-thread', label: '@codex:brand-new-thread' }] });
  });

  it('no identity + several sessions in the folder → refuse, list them, never guess', () => {
    const r = resolveSelfSessions(DIR, IOS, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ambiguous');
    expect(r.candidates.map((c) => c.sessionId)).toEqual([CLAUDE.sessionId, CODEX.sessionId]);
  });

  it('no identity + exactly one session in the folder → that one (Kimi / ZCode in their own folder)', () => {
    expect(resolveSelfSessions(DIR, '/other', {})).toEqual({ ok: true, targets: [{ id: 'k1', label: '@kimi:x' }] });
  });

  it('no identity + nothing in the folder → none', () => {
    expect(resolveSelfSessions(DIR, '/nowhere', {})).toEqual({ ok: false, reason: 'none', candidates: [] });
  });
});
