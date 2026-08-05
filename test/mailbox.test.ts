import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

describe('mailbox', () => {
  let mailbox: Mailbox;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    mailbox = createMailbox(createDb(':memory:'), { now: () => nowMs });
  });

  describe('send & conversations', () => {
    it('creates a message with pending status and self context id', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'hello' });
      expect(m.status).toBe('pending');
      expect(m.contextId).toBe(m.id);
      expect(m.parts).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('reuses the same conversation for both directions (unordered pair)', () => {
      const m1 = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'ping' });
      const m2 = mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'pong' });
      expect(m2.conversationId).toBe(m1.conversationId);
      expect(mailbox.listConversations()).toHaveLength(1);
    });

    it('lists conversations with message count and last message', () => {
      mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'first' });
      nowMs += 1000;
      mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'second' });
      const convos = mailbox.listConversations();
      expect(convos[0]?.messageCount).toBe(2);
      expect(convos[0]?.lastMessage?.parts[0]?.text).toBe('second');
      expect(convos[0]?.lastMessageAt).toBe(nowMs);
    });
  });

  describe('reply', () => {
    it('swaps from/to and inherits context and conversation', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'question' });
      const r = mailbox.reply(m.id, 'answer');
      expect(r.from).toEqual(CODEX_B);
      expect(r.to).toEqual(CLAUDE_A);
      expect(r.contextId).toBe(m.contextId);
      expect(r.conversationId).toBe(m.conversationId);
    });

    it('throws for unknown message id', () => {
      expect(() => mailbox.reply('nope', 'x')).toThrow(/not found/i);
    });
  });

  describe('delivery state machine', () => {
    it('claims pending → delivering, then delivered', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      const claimed = mailbox.claimNextPending();
      expect(claimed?.id).toBe(m.id);
      expect(claimed?.status).toBe('delivering');
      expect(mailbox.claimNextPending()).toBeNull(); // nothing else pending
      const done = mailbox.markDelivered(m.id);
      expect(done.status).toBe('delivered');
    });

    it('failed under the retry limit is re-claimable only after the backoff window', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      mailbox.claimNextPending();
      const failed = mailbox.markFailed(m.id, 'err 1');
      expect(failed.status).toBe('failed');
      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe('err 1');
      expect(mailbox.claimNextPending()).toBeNull(); // within backoff — not yet retryable
      nowMs += 31_000;
      expect(mailbox.claimNextPending()?.id).toBe(m.id);
    });

    it('goes dead after 3 failed attempts and is no longer claimable', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      for (let i = 0; i < 3; i++) {
        expect(mailbox.claimNextPending()?.id).toBe(m.id);
        mailbox.markFailed(m.id, 'boom');
        nowMs += 31_000; // pass the retry backoff window
      }
      expect(mailbox.getMessage(m.id)?.status).toBe('dead');
      expect(mailbox.claimNextPending()).toBeNull();
    });

    it('rejects illegal transitions', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      expect(() => mailbox.markDelivered(m.id)).toThrow(/pending -> delivered/i); // must claim first
    });
  });

  describe('inbox', () => {
    it('lists undelivered messages for a recipient session, take marks delivered', () => {
      mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'for codex' });
      mailbox.send({ from: CODEX_B, to: CLAUDE_A, text: 'for claude' });
      const forCodex = mailbox.inbox({ toSession: CODEX_B.sessionId });
      expect(forCodex).toHaveLength(1);
      expect(forCodex[0]?.parts[0]?.text).toBe('for codex');

      const taken = mailbox.inbox({ toSession: CODEX_B.sessionId, take: true });
      expect(taken).toHaveLength(1);
      expect(mailbox.inbox({ toSession: CODEX_B.sessionId })).toHaveLength(0);
      expect(mailbox.getMessage(taken[0]!.id)?.status).toBe('delivered');
    });
  });

  describe('web console support', () => {
    it('lists messages of a conversation in chronological order', () => {
      const m1 = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'one' });
      nowMs += 1000;
      mailbox.reply(m1.id, 'two');
      const msgs = mailbox.listMessages(m1.conversationId);
      expect(msgs.map((m) => m.parts[0]?.text)).toEqual(['one', 'two']);
      expect(mailbox.listMessages('nonexistent')).toEqual([]);
    });

    it('retry requeues a failed/dead message with attempts reset', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      for (let i = 0; i < 3; i++) {
        mailbox.claimNextPending();
        mailbox.markFailed(m.id, 'boom');
        nowMs += 31_000;
      }
      expect(mailbox.getMessage(m.id)?.status).toBe('dead');
      const retried = mailbox.retry(m.id);
      expect(retried.status).toBe('pending');
      expect(retried.attempts).toBe(0);
      expect(mailbox.claimNextPending()?.id).toBe(m.id);
    });

    it('retry rejects non-failed messages', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      expect(() => mailbox.retry(m.id)).toThrow(/only failed/i);
    });
  });

  describe('crash recovery', () => {
    it('requeues messages stranded in delivering by a dead daemon', () => {
      const m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      mailbox.claimNextPending(); // daemon claims, then "crashes"
      expect(mailbox.claimNextPending()).toBeNull(); // stranded — nothing claimable
      const recovered = mailbox.recoverStale();
      expect(recovered).toBe(1);
      nowMs += 31_000; // failed path respects the retry backoff
      expect(mailbox.claimNextPending()?.id).toBe(m.id);
    });

    it('is a no-op when nothing is stranded', () => {
      mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
      expect(mailbox.recoverStale()).toBe(0);
    });
  });

  describe('loop protection', () => {
    it('rejects when a context exceeds 12 messages', () => {
      let m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: '0' });
      for (let i = 1; i < 12; i++) {
        nowMs += 60_000; // avoid tripping the rate limit — this tests depth only
        m = mailbox.reply(m.id, `${i}`);
      }
      nowMs += 60_000;
      expect(() => mailbox.reply(m.id, 'over')).toThrow(/loop/i);
    });

    it('rejects more than 6 messages per context within a minute', () => {
      let m = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: '0' });
      for (let i = 1; i < 6; i++) {
        nowMs += 100;
        m = mailbox.reply(m.id, `${i}`);
      }
      nowMs += 100;
      expect(() => mailbox.reply(m.id, 'too fast')).toThrow(/rate/i);
    });
  });
});
