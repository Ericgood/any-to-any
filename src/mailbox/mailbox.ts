import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export interface SessionRef {
  agent: string;
  sessionId: string;
}

export interface MessagePart {
  type: 'text';
  text: string;
  via?: string;
}

export type MessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';

export interface Message {
  id: string;
  conversationId: string;
  contextId: string;
  from: SessionRef;
  to: SessionRef;
  parts: MessagePart[];
  status: MessageStatus;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  a: SessionRef;
  b: SessionRef;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  lastMessage?: Message;
}

export interface SendInput {
  from: SessionRef;
  to: SessionRef;
  text: string;
  contextId?: string;
  via?: string;
}

export interface InboxQuery {
  toSession?: string;
  take?: boolean;
  all?: boolean;
}

export interface Mailbox {
  send(input: SendInput): Message;
  reply(messageId: string, text: string, via?: string): Message;
  inbox(query?: InboxQuery): Message[];
  getMessage(id: string): Message | null;
  listConversations(): ConversationSummary[];
  listMessages(conversationId: string): Message[];
  claimNextPending(): Message | null;
  markDelivered(id: string): Message;
  markFailed(id: string, error: string): Message;
  retry(id: string): Message;
}

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30_000;
const LOOP_MAX_DEPTH = 12;
const LOOP_RATE_WINDOW_MS = 60_000;
const LOOP_RATE_MAX = 6;

interface MessageRow {
  id: string;
  conversation_id: string;
  context_id: string;
  from_agent: string;
  from_session: string;
  to_agent: string;
  to_session: string;
  parts: string;
  status: MessageStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    conversationId: row.conversation_id,
    contextId: row.context_id,
    from: { agent: row.from_agent, sessionId: row.from_session },
    to: { agent: row.to_agent, sessionId: row.to_session },
    parts: JSON.parse(row.parts) as MessagePart[],
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.last_error !== null) msg.lastError = row.last_error;
  return msg;
}

const pairKey = (a: SessionRef, b: SessionRef): string =>
  [a, b].map((r) => `${r.agent}:${r.sessionId}`).sort().join('|');

export function createMailbox(db: Db, opts: { now?: () => number } = {}): Mailbox {
  const now = opts.now ?? Date.now;

  const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');

  const getMessage = (id: string): Message | null => {
    const row = getMessageStmt.get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  };

  const ensureConversation = (from: SessionRef, to: SessionRef, ts: number): string => {
    const key = pairKey(from, to);
    const existing = db
      .prepare('SELECT id FROM conversations WHERE pair_key = ?')
      .get(key) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO conversations (id, pair_key, a_agent, a_session, b_agent, b_session, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, key, from.agent, from.sessionId, to.agent, to.sessionId, ts, ts);
    return id;
  };

  const assertLoopSafe = (contextId: string, ts: number): void => {
    const depth = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE context_id = ?').get(contextId) as { n: number }
    ).n;
    if (depth >= LOOP_MAX_DEPTH) {
      throw new Error(`loop protection: context ${contextId} already has ${depth} messages`);
    }
    const recent = (
      db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE context_id = ? AND created_at > ?')
        .get(contextId, ts - LOOP_RATE_WINDOW_MS) as { n: number }
    ).n;
    if (recent >= LOOP_RATE_MAX) {
      throw new Error(`rate protection: context ${contextId} has ${recent} messages in the last minute`);
    }
  };

  const insertMessage = (input: SendInput, ts: number): Message => {
    const id = randomUUID();
    const contextId = input.contextId ?? id;
    if (input.contextId) assertLoopSafe(input.contextId, ts);
    const conversationId = ensureConversation(input.from, input.to, ts);
    const part: MessagePart = input.via ? { type: 'text', text: input.text, via: input.via } : { type: 'text', text: input.text };
    db.prepare(
      `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, to_agent, to_session, parts, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(
      id,
      conversationId,
      contextId,
      input.from.agent,
      input.from.sessionId,
      input.to.agent,
      input.to.sessionId,
      JSON.stringify([part]),
      ts,
      ts,
    );
    const created = getMessage(id);
    if (!created) throw new Error('insert failed');
    return created;
  };

  return {
    send(input: SendInput): Message {
      return insertMessage(input, now());
    },

    reply(messageId: string, text: string, via?: string): Message {
      const original = getMessage(messageId);
      if (!original) throw new Error(`message not found: ${messageId}`);
      const input: SendInput = {
        from: original.to,
        to: original.from,
        text,
        contextId: original.contextId,
      };
      if (via) input.via = via;
      return insertMessage(input, now());
    },

    inbox(query: InboxQuery = {}): Message[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!query.all) clauses.push(`status IN ('pending', 'delivering', 'failed')`);
      if (query.toSession) {
        clauses.push('to_session = ?');
        params.push(query.toSession);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM messages ${where} ORDER BY created_at ASC`)
        .all(...params) as MessageRow[];
      const messages = rows.map(rowToMessage);
      if (query.take && messages.length > 0) {
        const ts = now();
        const mark = db.prepare(
          `UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ? AND status IN ('pending', 'delivering', 'failed')`,
        );
        for (const m of messages) mark.run(ts, m.id);
      }
      return messages;
    },

    getMessage,

    listConversations(): ConversationSummary[] {
      const rows = db
        .prepare('SELECT * FROM conversations ORDER BY last_message_at DESC')
        .all() as Array<{
        id: string;
        a_agent: string;
        a_session: string;
        b_agent: string;
        b_session: string;
        created_at: number;
        last_message_at: number;
      }>;
      return rows.map((row) => {
        const count = (
          db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(row.id) as { n: number }
        ).n;
        const last = db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(row.id) as MessageRow | undefined;
        const summary: ConversationSummary = {
          id: row.id,
          a: { agent: row.a_agent, sessionId: row.a_session },
          b: { agent: row.b_agent, sessionId: row.b_session },
          createdAt: row.created_at,
          lastMessageAt: row.last_message_at,
          messageCount: count,
        };
        if (last) summary.lastMessage = rowToMessage(last);
        return summary;
      });
    },

    listMessages(conversationId: string): Message[] {
      const rows = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(conversationId) as MessageRow[];
      return rows.map(rowToMessage);
    },

    retry(id: string): Message {
      const current = getMessage(id);
      if (!current) throw new Error(`message not found: ${id}`);
      if (current.status !== 'failed' && current.status !== 'dead') {
        throw new Error(`only failed/dead messages can be retried (status: ${current.status})`);
      }
      db.prepare(`UPDATE messages SET status = 'pending', attempts = 0, updated_at = ? WHERE id = ?`).run(now(), id);
      const updated = getMessage(id);
      if (!updated) throw new Error('update failed');
      return updated;
    },

    claimNextPending(): Message | null {
      const claim = db.transaction((): Message | null => {
        const row = db
          .prepare(
            `SELECT * FROM messages
             WHERE status = 'pending'
                OR (status = 'failed' AND attempts < ? AND updated_at <= ?)
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(MAX_ATTEMPTS, now() - RETRY_BACKOFF_MS) as MessageRow | undefined;
        if (!row) return null;
        db.prepare(`UPDATE messages SET status = 'delivering', updated_at = ? WHERE id = ?`).run(now(), row.id);
        return getMessage(row.id);
      });
      return claim();
    },

    markDelivered(id: string): Message {
      const current = getMessage(id);
      if (!current) throw new Error(`message not found: ${id}`);
      if (current.status !== 'delivering') {
        throw new Error(`illegal transition: ${current.status} -> delivered (must claim first)`);
      }
      db.prepare(`UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ?`).run(now(), id);
      const updated = getMessage(id);
      if (!updated) throw new Error('update failed');
      return updated;
    },

    markFailed(id: string, error: string): Message {
      const current = getMessage(id);
      if (!current) throw new Error(`message not found: ${id}`);
      if (current.status !== 'delivering') {
        throw new Error(`illegal transition: ${current.status} -> failed (must claim first)`);
      }
      const attempts = current.attempts + 1;
      const status: MessageStatus = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      db.prepare(
        `UPDATE messages SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, attempts, error, now(), id);
      const updated = getMessage(id);
      if (!updated) throw new Error('update failed');
      return updated;
    },
  };
}
