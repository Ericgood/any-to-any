import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { collectInbox, processPromptHook, recentExchange } from '../src/hooks/prompt-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

const home = mkdtempSync(join(tmpdir(), 'anytoany-hook-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('prompt hook (claude + codex shared)', () => {
  let mailbox: Mailbox;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    mailbox = createMailbox(createDb(':memory:'), { now: () => nowMs });
  });

  const run = (sessionId: string) =>
    processPromptHook(mailbox, { session_id: sessionId }, { home, now: () => nowMs });

  it('returns empty when nothing waiting and no new activity', () => {
    expect(run(`empty-${nowMs}`)).toEqual({});
  });

  it('injects pending messages fully and marks them delivered', () => {
    const m = mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'tests green on my side' });
    const out = run(CLAUDE_A.sessionId);
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('tests green on my side');
    expect(ctx).toContain(`anyd reply ${m.id}`);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
  });

  it('does not steal messages the dispatcher is delivering', () => {
    const m = mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'in flight' });
    mailbox.claimNextPending();
    const out = run(CLAUDE_A.sessionId);
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('in flight');
    expect(mailbox.getMessage(m.id)?.status).toBe('delivering');
  });

  it('shows already-handled traffic as an FYI digest exactly once (cursor)', () => {
    const sid = `codex-app-${nowMs}`;
    const m = mailbox.send({ from: CLAUDE_A, to: { agent: 'codex', sessionId: sid }, text: 'run the tests please' });
    mailbox.claimNextPending();
    mailbox.markDelivered(m.id); // headless resume already handled it
    nowMs += 1000;

    const out = run(sid);
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Activity digest');
    expect(ctx).toContain('run the tests please');
    expect(ctx).toMatch(/ALREADY processed/);
    expect(ctx).toMatch(/do NOT reply/);

    nowMs += 1000;
    expect(run(sid)).toEqual({}); // second prompt — digest not repeated
  });

  it('digest covers both directions (received and sent replies)', () => {
    const sid = `codex-app2-${nowMs}`;
    const m = mailbox.send({ from: CLAUDE_A, to: { agent: 'codex', sessionId: sid }, text: 'question' });
    mailbox.claimNextPending();
    mailbox.markDelivered(m.id);
    const r = mailbox.reply(m.id, 'the answer');
    mailbox.claimNextPending();
    mailbox.markDelivered(r.id);
    nowMs += 1000;

    const ctx = run(sid).hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('← received');
    expect(ctx).toContain('→ sent to');
  });

  it('handles missing session id gracefully', () => {
    expect(processPromptHook(mailbox, {}, { home })).toEqual({});
  });

  it('frames injected messages as a trusted teammate (ADR-016), not external data', () => {
    mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'please run tests' });
    const ctx = run(CLAUDE_A.sessionId).hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toMatch(/trusted teammate|ADR-016/i);
    expect(ctx).not.toMatch(/treat as external data/i);
  });
});

describe('collectInbox (shared by hook and `anyd pull`)', () => {
  let mailbox: Mailbox;
  let nowMs: number;
  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    mailbox = createMailbox(createDb(':memory:'), { now: () => nowMs });
  });

  it('recentExchange shows the full recent exchange both directions incl. dead, ignoring the cursor', () => {
    let t = 1_700_000_000_000;
    const mb = createMailbox(createDb(':memory:'), { now: () => t });
    const SID = 'sess-hist';
    const CLAUDE = { agent: 'claude', sessionId: 'claude-x' };
    const m1 = mb.send({ from: CLAUDE, to: { agent: 'codex', sessionId: SID }, text: 'please review PR 42' });
    mb.claimNextPending();
    mb.markDelivered(m1.id);
    t += 1000;
    const r = mb.reply(m1.id, 'DONE reviewed');
    mb.claimNextPending();
    mb.markDelivered(r.id);
    t += 1000;
    const m2 = mb.send({ from: CLAUDE, to: { agent: 'codex', sessionId: SID }, text: 'timed-out long message' });
    for (let i = 0; i < 3; i++) {
      mb.claimNextPending();
      mb.markFailed(m2.id, 'timeout');
      t += 31_000;
    }
    const out = recentExchange(mb, SID, 15) ?? '';
    expect(out).toContain('please review PR 42'); // received, full text
    expect(out).toContain('DONE reviewed'); // sent reply, full text
    expect(out).toContain('timed-out long message'); // the dead one is shown
    expect(out).toMatch(/dead|never reached/i); // and flagged as undelivered
    expect(recentExchange(createMailbox(createDb(':memory:')), 'nobody')).toBeNull();
  });

  it('returns pending text and takes the message; null when nothing new', () => {
    const sid = `pull-${nowMs}`;
    const m = mailbox.send({ from: CLAUDE_A, to: { agent: 'codex', sessionId: sid }, text: 'peer needs a review' });
    const text = collectInbox(mailbox, sid, { home, now: () => nowMs });
    expect(text).toContain('peer needs a review');
    expect(text).toContain(`anyd reply ${m.id}`);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered'); // taken
    nowMs += 1000;
    expect(collectInbox(mailbox, sid, { home, now: () => nowMs })).toBeNull(); // nothing new now
  });
});
