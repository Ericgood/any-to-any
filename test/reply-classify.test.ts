import { describe, expect, it } from 'vitest';
import { classifyReply } from '../src/envelope.js';

// ADR-032: one rule for "should this reply be filed", shared by the stdout-marker
// path (dispatcher) and the command path (`anyd reply`, used by Codex Desktop's queue).
describe('classifyReply', () => {
  it('files a substantive reply', () => {
    expect(classifyReply('please run the tests', 'DONE all 12 pass')).toBe('file');
  });

  it('drops a bare NOOP — the "nothing new to add" escape hatch', () => {
    expect(classifyReply('DONE pushed abc123', 'NOOP')).toBe('noop');
  });

  it('drops NOOP with leading whitespace or prose after it', () => {
    expect(classifyReply('DONE pushed', '  NOOP')).toBe('noop');
    expect(classifyReply('DONE pushed', 'NOOP\n---\nstanding by')).toBe('noop');
  });

  it('does not mistake a NOOP-prefixed word for a noop verdict', () => {
    expect(classifyReply('question?', 'NOOPETH is real content')).toBe('file');
  });

  it('suppresses BLOCKED answering BLOCKED', () => {
    expect(classifyReply('BLOCKED waiting for user', 'BLOCKED same here')).toBe('blocked-pingpong');
    expect(classifyReply('  BLOCKED waiting', '\nBLOCKED me too')).toBe('blocked-pingpong');
  });

  it('lets a substantive reply to a BLOCKED message through', () => {
    expect(classifyReply('BLOCKED need the API key path', 'it is in ~/.config/x')).toBe('file');
  });
});

// End-to-end through the real CLI: the command path Codex Desktop uses (ADR-027).
describe('anyd reply (command path)', () => {
  const run = async (home: string, id: string, text: string) => {
    const { execFileSync } = await import('node:child_process');
    return execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'reply', id, text], {
      env: { ...process.env, ANYTOANY_HOME: home },
      encoding: 'utf8',
    });
  };
  const setup = async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createDb } = await import('../src/mailbox/db.js');
    const { createMailbox } = await import('../src/mailbox/mailbox.js');
    const home = mkdtempSync(join(tmpdir(), 'anyd-reply-'));
    const mailbox = createMailbox(createDb(join(home, '.anytoany', 'mailbox.db')));
    const m = mailbox.send({
      from: { agent: 'claude', sessionId: 'c1' },
      to: { agent: 'codex', sessionId: 'x1' },
      text: 'DONE index updated',
    });
    return { home, mailbox, id: m.id };
  };

  it('does not file a NOOP — the other side is never woken', async () => {
    const { home, mailbox, id } = await setup();
    const out = await run(home, id, 'NOOP');
    expect(out).toMatch(/no reply sent/);
    expect(mailbox.inbox({ all: true })).toHaveLength(1);
  }, 20000);

  it('still files a real reply', async () => {
    const { home, mailbox, id } = await setup();
    const out = await run(home, id, 'DONE thanks, card updated');
    expect(out).toMatch(/queued reply/);
    expect(mailbox.inbox({ all: true })).toHaveLength(2);
  }, 20000);
});
