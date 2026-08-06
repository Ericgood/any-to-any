import Database from 'better-sqlite3';
export type Db = Database.Database;
export declare function defaultDbPath(): string;
/** Open (creating if needed) the mailbox database. Pass ':memory:' in tests. */
export declare function createDb(path?: string): Db;
