import { randomUUID } from 'node:crypto';
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30_000;
const LOOP_MAX_DEPTH = 12;
const LOOP_RATE_WINDOW_MS = 60_000;
const LOOP_RATE_MAX = 6;
function rowToRef(agent, session, device) {
    const ref = { agent, sessionId: session };
    if (device)
        ref.device = device;
    return ref;
}
function rowToMessage(row) {
    const msg = {
        id: row.id,
        conversationId: row.conversation_id,
        contextId: row.context_id,
        from: rowToRef(row.from_agent, row.from_session, row.from_device),
        to: rowToRef(row.to_agent, row.to_session, row.to_device),
        parts: JSON.parse(row.parts),
        status: row.status,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (row.last_error !== null)
        msg.lastError = row.last_error;
    return msg;
}
const pairKey = (a, b) => [a, b].map((r) => `${r.device ?? ''}/${r.agent}:${r.sessionId}`).sort().join('|');
export function createMailbox(db, opts = {}) {
    const now = opts.now ?? Date.now;
    const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
    const getMessage = (id) => {
        const row = getMessageStmt.get(id);
        return row ? rowToMessage(row) : null;
    };
    const ensureConversation = (from, to, ts) => {
        const key = pairKey(from, to);
        const existing = db
            .prepare('SELECT id FROM conversations WHERE pair_key = ?')
            .get(key);
        if (existing) {
            db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, existing.id);
            return existing.id;
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO conversations (id, pair_key, a_agent, a_session, a_device, b_agent, b_session, b_device, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, key, from.agent, from.sessionId, from.device ?? null, to.agent, to.sessionId, to.device ?? null, ts, ts);
        return id;
    };
    const assertLoopSafe = (contextId, ts) => {
        const depth = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE context_id = ?').get(contextId).n;
        if (depth >= LOOP_MAX_DEPTH) {
            throw new Error(`loop protection: context ${contextId} already has ${depth} messages`);
        }
        const recent = db
            .prepare('SELECT COUNT(*) AS n FROM messages WHERE context_id = ? AND created_at > ?')
            .get(contextId, ts - LOOP_RATE_WINDOW_MS).n;
        if (recent >= LOOP_RATE_MAX) {
            throw new Error(`rate protection: context ${contextId} has ${recent} messages in the last minute`);
        }
    };
    const insertMessage = (input, ts) => {
        const id = randomUUID();
        const contextId = input.contextId ?? id;
        if (input.contextId)
            assertLoopSafe(input.contextId, ts);
        const conversationId = ensureConversation(input.from, input.to, ts);
        const part = input.via ? { type: 'text', text: input.text, via: input.via } : { type: 'text', text: input.text };
        db.prepare(`INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, to_device, parts, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(id, conversationId, contextId, input.from.agent, input.from.sessionId, input.from.device ?? null, input.to.agent, input.to.sessionId, input.to.device ?? null, JSON.stringify([part]), ts, ts);
        const created = getMessage(id);
        if (!created)
            throw new Error('insert failed');
        return created;
    };
    return {
        send(input) {
            return insertMessage(input, now());
        },
        reply(messageId, text, via) {
            const original = getMessage(messageId);
            if (!original)
                throw new Error(`message not found: ${messageId}`);
            const input = {
                from: original.to,
                to: original.from,
                text,
                contextId: original.contextId,
            };
            if (via)
                input.via = via;
            return insertMessage(input, now());
        },
        inbox(query = {}) {
            const clauses = [];
            const params = [];
            if (query.pendingOnly)
                clauses.push(`status = 'pending'`);
            else if (!query.all)
                clauses.push(`status IN ('pending', 'delivering', 'failed')`);
            if (query.toSession) {
                clauses.push('to_session = ?');
                params.push(query.toSession);
            }
            const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
            const rows = db
                .prepare(`SELECT * FROM messages ${where} ORDER BY created_at ASC`)
                .all(...params);
            const messages = rows.map(rowToMessage);
            if (query.take && messages.length > 0) {
                const ts = now();
                const mark = db.prepare(`UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ? AND status IN ('pending', 'delivering', 'failed')`);
                for (const m of messages)
                    mark.run(ts, m.id);
            }
            return messages;
        },
        getMessage,
        listConversations() {
            const rows = db
                .prepare('SELECT * FROM conversations ORDER BY last_message_at DESC')
                .all();
            return rows.map((row) => {
                const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(row.id).n;
                const last = db
                    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
                    .get(row.id);
                const summary = {
                    id: row.id,
                    a: rowToRef(row.a_agent, row.a_session, row.a_device),
                    b: rowToRef(row.b_agent, row.b_session, row.b_device),
                    createdAt: row.created_at,
                    lastMessageAt: row.last_message_at,
                    messageCount: count,
                };
                if (last)
                    summary.lastMessage = rowToMessage(last);
                return summary;
            });
        },
        listMessages(conversationId) {
            const rows = db
                .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
                .all(conversationId);
            return rows.map(rowToMessage);
        },
        retry(id) {
            const current = getMessage(id);
            if (!current)
                throw new Error(`message not found: ${id}`);
            if (current.status !== 'failed' && current.status !== 'dead') {
                throw new Error(`only failed/dead messages can be retried (status: ${current.status})`);
            }
            db.prepare(`UPDATE messages SET status = 'pending', attempts = 0, updated_at = ? WHERE id = ?`).run(now(), id);
            const updated = getMessage(id);
            if (!updated)
                throw new Error('update failed');
            return updated;
        },
        recoverStale() {
            const result = db
                .prepare(`UPDATE messages SET status = 'failed', last_error = 'daemon restarted mid-delivery (message may have been injected)', updated_at = ?
           WHERE status = 'delivering'`)
                .run(now());
            return result.changes;
        },
        recentActivity(sessionId, sinceMs, limit = 10) {
            const rows = db
                .prepare(`SELECT * FROM messages
           WHERE (to_session = ? OR from_session = ?) AND updated_at > ?
           ORDER BY created_at ASC LIMIT ?`)
                .all(sessionId, sessionId, sinceMs, limit);
            return rows.map(rowToMessage);
        },
        claimNextPending() {
            const claim = db.transaction(() => {
                const row = db
                    .prepare(`SELECT * FROM messages
             WHERE status = 'pending'
                OR (status = 'failed' AND attempts < ? AND updated_at <= ?)
             ORDER BY created_at ASC LIMIT 1`)
                    .get(MAX_ATTEMPTS, now() - RETRY_BACKOFF_MS);
                if (!row)
                    return null;
                db.prepare(`UPDATE messages SET status = 'delivering', updated_at = ? WHERE id = ?`).run(now(), row.id);
                return getMessage(row.id);
            });
            return claim();
        },
        markDelivered(id) {
            const current = getMessage(id);
            if (!current)
                throw new Error(`message not found: ${id}`);
            if (current.status !== 'delivering') {
                throw new Error(`illegal transition: ${current.status} -> delivered (must claim first)`);
            }
            db.prepare(`UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ?`).run(now(), id);
            const updated = getMessage(id);
            if (!updated)
                throw new Error('update failed');
            return updated;
        },
        markFailed(id, error) {
            const current = getMessage(id);
            if (!current)
                throw new Error(`message not found: ${id}`);
            if (current.status !== 'delivering') {
                throw new Error(`illegal transition: ${current.status} -> failed (must claim first)`);
            }
            const attempts = current.attempts + 1;
            const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
            db.prepare(`UPDATE messages SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(status, attempts, error, now(), id);
            const updated = getMessage(id);
            if (!updated)
                throw new Error('update failed');
            return updated;
        },
    };
}
//# sourceMappingURL=mailbox.js.map