import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export interface SessionRef {
  agent: string;
  sessionId: string;
  /** Device name for remote refs; unset = this machine. */
  device?: string;
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
  /** Land in this existing conversation instead of deriving one from the
   *  (from,to) pair — keeps three-party traffic (user + agent pair) in ONE thread. */
  conversationId?: string;
}

export interface InboxQuery {
  toSession?: string;
  take?: boolean;
  all?: boolean;
  /** Only strictly-pending messages — excludes 'delivering' (dispatcher-owned) and 'failed'. */
  pendingOnly?: boolean;
}

export interface Mailbox {
  send(input: SendInput): Message;
  reply(messageId: string, text: string, via?: string): Message;
  inbox(query?: InboxQuery): Message[];
  getMessage(id: string): Message | null;
  listConversations(): ConversationSummary[];
  listMessages(conversationId: string): Message[];
  /** Stable conversationId for a session pair (order-independent); creates the
   *  row if absent WITHOUT bumping last_message_at. Used to key a collab doc. */
  getOrCreateConversation(from: SessionRef, to: SessionRef): string;
  claimNextPending(): Message | null;
  markDelivered(id: string): Message;
  markFailed(id: string, error: string, opts?: { terminal?: boolean }): Message;
  retry(id: string): Message;
  /** Requeue messages stranded in 'delivering' by a crashed daemon (at-least-once). */
  recoverStale(): number;
  /** All traffic touching a session (either direction) since a timestamp — for visibility digests. */
  recentActivity(sessionId: string, sinceMs: number, limit?: number): Message[];
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
  from_device: string | null;
  to_agent: string;
  to_session: string;
  to_device: string | null;
  parts: string;
  status: MessageStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRef(agent: string, session: string, device: string | null): SessionRef {
  const ref: SessionRef = { agent, sessionId: session };
  if (device) ref.device = device;
  return ref;
}

function rowToMessage(row: MessageRow): Message {
  const msg: Message = {
    id: row.id,
    conversationId: row.conversation_id,
    contextId: row.context_id,
    from: rowToRef(row.from_agent, row.from_session, row.from_device),
    to: rowToRef(row.to_agent, row.to_session, row.to_device),
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
  [a, b].map((r) => `${r.device ?? ''}/${r.agent}:${r.sessionId}`).sort().join('|');

export function createMailbox(db: Db, opts: { now?: () => number } = {}): Mailbox {
  const now = opts.now ?? Date.now;

  const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');

  const getMessage = (id: string): Message | null => {
    const row = getMessageStmt.get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  };

  const findConversationId = (from: SessionRef, to: SessionRef): string | undefined => {
    const row = db
      .prepare('SELECT id FROM conversations WHERE pair_key = ?')
      .get(pairKey(from, to)) as { id: string } | undefined;
    return row?.id;
  };

  const createConversation = (from: SessionRef, to: SessionRef, ts: number): string => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO conversations (id, pair_key, a_agent, a_session, a_device, b_agent, b_session, b_device, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, pairKey(from, to), from.agent, from.sessionId, from.device ?? null, to.agent, to.sessionId, to.device ?? null, ts, ts);
    return id;
  };

  const ensureConversation = (from: SessionRef, to: SessionRef, ts: number): string => {
    const existing = findConversationId(from, to);
    if (existing) {
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, existing);
      return existing;
    }
    return createConversation(from, to, ts);
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
    let conversationId: string;
    if (input.conversationId) {
      const exists = db
        .prepare('SELECT id FROM conversations WHERE id = ?')
        .get(input.conversationId) as { id: string } | undefined;
      if (!exists) throw new Error(`conversation not found: ${input.conversationId}`);
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, input.conversationId);
      conversationId = input.conversationId;
    } else {
      conversationId = ensureConversation(input.from, input.to, ts);
    }
    const part: MessagePart = input.via ? { type: 'text', text: input.text, via: input.via } : { type: 'text', text: input.text };
    db.prepare(
      `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, to_device, parts, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(
      id,
      conversationId,
      contextId,
      input.from.agent,
      input.from.sessionId,
      input.from.device ?? null,
      input.to.agent,
      input.to.sessionId,
      input.to.device ?? null,
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
        // stay in the original thread — replying to a piggybacked user message
        // must not fork a user↔agent pair conversation
        conversationId: original.conversationId,
      };
      if (via) input.via = via;
      return insertMessage(input, now());
    },

    inbox(query: InboxQuery = {}): Message[] {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.pendingOnly) clauses.push(`status = 'pending'`);
      else if (!query.all) clauses.push(`status IN ('pending', 'delivering', 'failed')`);
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
        a_device: string | null;
        b_agent: string;
        b_session: string;
        b_device: string | null;
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
          a: rowToRef(row.a_agent, row.a_session, row.a_device),
          b: rowToRef(row.b_agent, row.b_session, row.b_device),
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

    getOrCreateConversation(from: SessionRef, to: SessionRef): string {
      return findConversationId(from, to) ?? createConversation(from, to, now());
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

    recoverStale(): number {
      const result = db
        .prepare(
          `UPDATE messages SET status = 'failed', last_error = 'daemon restarted mid-delivery (message may have been injected)', updated_at = ?
           WHERE status = 'delivering'`,
        )
        .run(now());
      return result.changes;
    },

    recentActivity(sessionId: string, sinceMs: number, limit = 10): Message[] {
      const rows = db
        .prepare(
          `SELECT * FROM messages
           WHERE (to_session = ? OR from_session = ?) AND updated_at > ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(sessionId, sessionId, sinceMs, limit) as MessageRow[];
      return rows.map(rowToMessage);
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

    markFailed(id: string, error: string, opts?: { terminal?: boolean }): Message {
      const current = getMessage(id);
      if (!current) throw new Error(`message not found: ${id}`);
      if (current.status !== 'delivering') {
        throw new Error(`illegal transition: ${current.status} -> failed (must claim first)`);
      }
      const attempts = current.attempts + 1;
      // terminal = don't auto-retry (e.g. a timeout whose turn already ran)
      const status: MessageStatus = opts?.terminal || attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      db.prepare(
        `UPDATE messages SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, attempts, error, now(), id);
      const updated = getMessage(id);
      if (!updated) throw new Error('update failed');
      return updated;
    },
  };
}
