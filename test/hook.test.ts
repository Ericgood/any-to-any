import { beforeEach, describe, expect, it } from 'vitest';
import { processPromptSubmitHook } from '../src/hooks/claude-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

describe('claude UserPromptSubmit hook', () => {
  let mailbox: Mailbox;

  beforeEach(() => {
    mailbox = createMailbox(createDb(':memory:'));
  });

  it('returns empty output when no messages are waiting', () => {
    const out = processPromptSubmitHook(mailbox, { session_id: CLAUDE_A.sessionId });
    expect(out).toEqual({});
  });

  it('injects waiting messages as additionalContext and marks them delivered', () => {
    const m = mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'tests are green on my side' });
    const out = processPromptSubmitHook(mailbox, { session_id: CLAUDE_A.sessionId });
    const ctx = out.hookSpecificOutput?.additionalContext ?? '';
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(ctx).toContain('[anytoany]');
    expect(ctx).toContain('tests are green on my side');
    expect(ctx).toContain(m.id); // reply instructions need the id
    expect(ctx).toMatch(/anyd reply/);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    // second submit — nothing new to inject
    expect(processPromptSubmitHook(mailbox, { session_id: CLAUDE_A.sessionId })).toEqual({});
  });

  it('only takes messages addressed to this session', () => {
    mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'for codex, not for claude' });
    const out = processPromptSubmitHook(mailbox, { session_id: CLAUDE_A.sessionId });
    expect(out).toEqual({});
  });

  it('handles missing session_id gracefully', () => {
    expect(processPromptSubmitHook(mailbox, {})).toEqual({});
  });
});
