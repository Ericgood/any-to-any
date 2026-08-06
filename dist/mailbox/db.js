import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { anytoanyHome } from '../home.js';
import Database from 'better-sqlite3';
export function defaultDbPath() {
    return join(anytoanyHome(), '.anytoany', 'mailbox.db');
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  a_agent TEXT NOT NULL,
  a_session TEXT NOT NULL,
  a_device TEXT,
  b_agent TEXT NOT NULL,
  b_session TEXT NOT NULL,
  b_device TEXT,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  context_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_device TEXT,
  to_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  to_device TEXT,
  parts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(context_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session, status);
CREATE TABLE IF NOT EXISTS sessions_cache (
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  last_active_at INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);
`;
/** Phase 2 additive columns for databases created by Phase 1. */
const MIGRATIONS = [
    `ALTER TABLE conversations ADD COLUMN a_device TEXT`,
    `ALTER TABLE conversations ADD COLUMN b_device TEXT`,
    `ALTER TABLE messages ADD COLUMN from_device TEXT`,
    `ALTER TABLE messages ADD COLUMN to_device TEXT`,
];
/** Open (creating if needed) the mailbox database. Pass ':memory:' in tests. */
export function createDb(path = defaultDbPath()) {
    if (path !== ':memory:')
        mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    for (const migration of MIGRATIONS) {
        try {
            db.exec(migration);
        }
        catch {
            /* column already exists — idempotent by design */
        }
    }
    return db;
}
//# sourceMappingURL=db.js.map