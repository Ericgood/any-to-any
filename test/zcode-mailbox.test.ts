import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createZcodeAdapter } from '../src/adapters/zcode.js';
import {
  isSessionBusy,
  mailboxEnabledFor,
  mailboxRoot,
  postToMailbox,
  reclaimMail,
} from '../src/adapters/zcode-mailbox.js';
import type { ExecFn, SessionInfo } from '../src/adapters/types.js';

const SID = 'sess_149a52e6-713e-4939-bfd5-240cc9bea10d';
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('ZCode mailbox files (format from ZCode source, ADR-029)', () => {
  it('root honours ZCODE_MAILBOX_ROOT, else ~/.zcode/mailbox', () => {
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: '/x/mb' }, '/home/u')).toBe('/x/mb');
    expect(mailboxRoot({}, '/home/u')).toBe('/home/u/.zcode/mailbox');
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: '~/mb' }, '/home/u')).toBe('/home/u/mb');
  });

  it('a session counts as mailbox-enabled once ZCode itself created its unread/ dir', () => {
    const root = tmp('anyd-zmb-');
    expect(mailboxEnabledFor(root, SID)).toBe(false);
    mkdirSync(join(root, SID, 'unread'), { recursive: true });
    expect(mailboxEnabledFor(root, SID)).toBe(true);
  });

  it('posts a version-1 envelope atomically into unread/ (no temp file left behind)', () => {
    const root = tmp('anyd-zmb-');
    const path = postToMailbox(root, {
      messageId: 'abc-123',
      fromSessionId: 'anytoany:@codex:01a12d8a',
      toSessionId: SID,
      content: 'hello from codex',
      createdAt: '2026-10-13T16:00:00.000Z',
    });
    expect(path.startsWith(join(root, SID, 'unread'))).toBe(true);
    expect(path.endsWith('.json')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      messageId: 'abc-123',
      fromSessionId: 'anytoany:@codex:01a12d8a',
      toSessionId: SID,
      content: 'hello from codex',
      createdAt: '2026-10-13T16:00:00.000Z',
    });
    const leftovers = readdirSync(join(root, SID)).filter((f) => f !== 'unread');
    expect(leftovers).toEqual([]);
  });

  it('refuses a session id ZCode would refuse (path escape)', () => {
    const root = tmp('anyd-zmb-');
    const base = { messageId: 'm', fromSessionId: 'f', content: 'c', createdAt: 'now' };
    expect(() => postToMailbox(root, { ...base, toSessionId: '../etc' })).toThrow(/session id/);
    expect(() => postToMailbox(root, { ...base, toSessionId: 'sess_a/../../x' })).toThrow(/session id/);
  });

  it('reclaim and drain race: exactly one of them wins', () => {
    const root = tmp('anyd-zmb-');
    const base = { messageId: 'm1', fromSessionId: 'f', toSessionId: SID, content: 'c', createdAt: 'now' };
    const a = postToMailbox(root, base);
    expect(reclaimMail(a)).toBe(true); // nobody read it — we took it back
    expect(existsSync(a)).toBe(false);
    const b = postToMailbox(root, { ...base, messageId: 'm2' });
    mkdirSync(join(root, SID, 'read'), { recursive: true });
    renameSync(b, join(root, SID, 'read', 'x.json')); // ZCode drained it first
    expect(reclaimMail(b)).toBe(false);
  });
});

describe('is the ZCode session running a turn right now?', () => {
  function dbWith(rows: Array<{ role: string; created: number; completed?: number }>): string {
    const file = join(tmp('anyd-zdb-'), 'db.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)');
    rows.forEach((r, i) => {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(
        `msg_${i}`,
        SID,
        r.created,
        r.created,
        JSON.stringify({ role: r.role, time: { created: r.created, ...(r.completed ? { completed: r.completed } : {}) } }),
        i,
      );
    });
    db.close();
    return file;
  }
  const NOW = 1_791_906_200_000;

  it('assistant message without `completed` → busy (verified live: absent during `sleep 20`)', () => {
    expect(isSessionBusy(dbWith([{ role: 'user', created: NOW - 5000 }, { role: 'assistant', created: NOW - 4000 }]), SID, NOW)).toBe(true);
  });

  it('finished turn → not busy', () => {
    expect(isSessionBusy(dbWith([{ role: 'assistant', created: NOW - 9000, completed: NOW - 1000 }]), SID, NOW)).toBe(false);
  });

  it('a turn "running" for over 30 minutes is a crash leftover → not busy', () => {
    expect(isSessionBusy(dbWith([{ role: 'assistant', created: NOW - 31 * 60_000 }]), SID, NOW)).toBe(false);
  });

  it('a user message from the last minute with no answer yet → busy (turn starting)', () => {
    expect(isSessionBusy(dbWith([{ role: 'user', created: NOW - 10_000 }]), SID, NOW)).toBe(true);
    expect(isSessionBusy(dbWith([{ role: 'user', created: NOW - 5 * 60_000 }]), SID, NOW)).toBe(false);
  });

  it('no db / no messages → not busy', () => {
    expect(isSessionBusy('/nonexistent/db.sqlite', SID, NOW)).toBe(false);
    expect(isSessionBusy(dbWith([]), SID, NOW)).toBe(false);
  });
});

describe('ZCode delivery picks the doorbell only when the session is mid-turn with its mailbox on', () => {
  const session: SessionInfo = { agent: 'zcode', sessionId: SID, title: 't', cwd: '/w/p', lastActiveAt: 0 };

  function harness(opts: { busy: () => boolean; enabled: boolean; onPoll?: (root: string) => void }) {
    const root = tmp('anyd-zroute-');
    if (opts.enabled) mkdirSync(join(root, SID, 'unread'), { recursive: true });
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: 'RESUMED <<<ANYTOANY_REPLY>>> DONE', stderr: '', code: 0 };
    };
    const adapter = createZcodeAdapter({
      exec,
      engineBin: '/fake/zcode',
      configFile: '/nonexistent/config.json',
      mailboxRoot: root,
      isBusy: () => opts.busy(),
      pollMs: 1,
      sleep: async () => opts.onPoll?.(root),
    });
    return { adapter, calls, root };
  }

  it('mid-turn + mailbox on: the envelope goes into the mailbox, no headless turn; replies via anyd reply', async () => {
    const drain = (root: string) => {
      const dir = join(root, SID, 'unread');
      for (const f of readdirSync(dir)) {
        mkdirSync(join(root, SID, 'read'), { recursive: true });
        renameSync(join(dir, f), join(root, SID, 'read', f)); // what ZCode does at PostToolUse/Stop
      }
    };
    const { adapter, calls, root } = harness({ busy: () => true, enabled: true, onPoll: drain });
    expect(adapter.replyChannel?.(session)).toBe('command');
    const r = await adapter.deliver(session, 'ENVELOPE');
    expect(r).toEqual({ ok: true, output: '' });
    expect(calls).toEqual([]);
    const [read] = readdirSync(join(root, SID, 'read'));
    expect(JSON.parse(readFileSync(join(root, SID, 'read', read!), 'utf8')).content).toBe('ENVELOPE');
  });

  it('turn ends but the mail was never picked up → taken back and delivered the old way, exactly once', async () => {
    let polls = 0;
    const { adapter, calls, root } = harness({ busy: () => polls++ < 2, enabled: true });
    const r = await adapter.deliver(session, 'ENVELOPE');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--resume');
    expect(readdirSync(join(root, SID, 'unread'))).toEqual([]); // nothing left to be read twice
  });

  it('idle session → headless resume as before', async () => {
    const { adapter, calls } = harness({ busy: () => false, enabled: true });
    expect(adapter.replyChannel?.(session)).toBe('marker');
    await adapter.deliver(session, 'ENVELOPE');
    expect(calls[0]).toContain('--resume');
  });

  it('mid-turn but mailbox never enabled → headless resume (no file written)', async () => {
    const { adapter, calls, root } = harness({ busy: () => true, enabled: false });
    expect(adapter.replyChannel?.(session)).toBe('marker');
    await adapter.deliver(session, 'ENVELOPE');
    expect(calls[0]).toContain('--resume');
    expect(existsSync(join(root, SID))).toBe(false);
  });
});

describe('doctor: ZCode doorbell status', () => {
  it('on when ZCode left unread/ dirs, off (with the how-to) otherwise, silent without ZCode', async () => {
    const { zcodeMailboxCheck } = await import('../src/doctor.js');
    const root = tmp('anyd-zdoc-');
    expect(zcodeMailboxCheck(root, false)).toBeNull();
    expect(zcodeMailboxCheck(root, true)?.note).toMatch(/^off .*launchctl setenv ZCODE_MESSAGE_ENABLED 1/);
    mkdirSync(join(root, SID, 'unread'), { recursive: true });
    expect(zcodeMailboxCheck(root, true)?.note).toMatch(/^on — 1 session/);
  });
});
