import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCodexLiveness,
  parseCodexLockHolders,
  parseLiveClaudeSessions,
} from '../src/daemon/session-liveness.js';

// Real `ps -o command` shapes: an interactive Claude uses `--resume=<uuid>` (an `=`);
// anytoany's own headless delivery uses `--resume <uuid>` (a space). Only the former
// means "a human has this session open" — the dispatcher must skip resume-delivery to it.
const INTERACTIVE =
  '/Applications/Claude.app/.../claude --output-format stream-json --verbose --resume=43ac9165-2caf-43ff-b3dc-e3a0e39e432b --allowedTools mcp__x';
const DELIVERY =
  'claude -p --resume 1157e30d-7a87-4215-8cfa-a275edbd9480 [anytoany] Cross-agent message …';

describe('parseLiveClaudeSessions', () => {
  it('picks up interactively-open sessions (--resume=<uuid>)', () => {
    const live = parseLiveClaudeSessions(`${INTERACTIVE}\nsome other process\n`);
    expect(live.has('43ac9165-2caf-43ff-b3dc-e3a0e39e432b')).toBe(true);
    expect(live.size).toBe(1);
  });

  it('does NOT treat our own headless `-p --resume <uuid>` delivery as live', () => {
    const live = parseLiveClaudeSessions(`${DELIVERY}\n`);
    expect(live.has('1157e30d-7a87-4215-8cfa-a275edbd9480')).toBe(false);
    expect(live.size).toBe(0);
  });

  it('collects multiple live sessions and ignores noise', () => {
    const live = parseLiveClaudeSessions(
      `${INTERACTIVE}\n${DELIVERY}\nfoo --resume=11111111-2222-4333-8444-555555555555 bar\n`,
    );
    expect(live).toEqual(
      new Set(['43ac9165-2caf-43ff-b3dc-e3a0e39e432b', '11111111-2222-4333-8444-555555555555']),
    );
  });

  it('returns an empty set for empty/garbage input', () => {
    expect(parseLiveClaudeSessions('').size).toBe(0);
    expect(parseLiveClaudeSessions('no resume here at all').size).toBe(0);
  });
});

// ADR-026: a Codex thread has a live writer while `<CODEX_HOME>/thread-writer-locks/<id>.lock`
// is flock-held (upstream codex-rs/rollout/src/writer_lock.rs). Real `lsof -F n` output
// from 2026-10-12: Codex Desktop's app-server (pid 1220) holding two thread locks.
const LSOF_REAL = [
  'p1220',
  'f48',
  'n/Users/me/.codex/thread-writer-locks/019ef16c-eff8-7053-946b-5ef73e1e1f41.lock',
  'f74',
  'n019f5bf9-e99a-7503-8faf-eba4e9949715.lock', // lsof echoes relative paths as given
  '',
].join('\n');

describe('parseCodexLockHolders', () => {
  it('extracts thread ids of held writer locks from `lsof -F n` output', () => {
    expect(parseCodexLockHolders(LSOF_REAL)).toEqual(
      new Set(['019ef16c-eff8-7053-946b-5ef73e1e1f41', '019f5bf9-e99a-7503-8faf-eba4e9949715']),
    );
  });

  it('ignores pid/fd lines, the coordination lock and non-thread files', () => {
    const out = 'p1\nf3\nn/x/thread-writer-locks/.coordination.lock\nn/x/other.lock\nn/x/foo.txt\n';
    expect(parseCodexLockHolders(out).size).toBe(0);
    expect(parseCodexLockHolders('').size).toBe(0);
  });
});

describe('createCodexLiveness', () => {
  const T1 = '019ef16c-eff8-7053-946b-5ef73e1e1f41';
  const T2 = '01a0b5e0-3622-7a01-9c39-5740ca342be2';
  const lockDir = () => mkdtempSync(join(tmpdir(), 'anytoany-codexlocks-'));

  it('reports a thread live only when its lock file is actually held (stale crash leftovers are not)', () => {
    const dir = lockDir();
    writeFileSync(join(dir, `${T1}.lock`), '');
    writeFileSync(join(dir, `${T2}.lock`), ''); // orphan from a crashed writer — nobody holds it
    writeFileSync(join(dir, '.coordination.lock'), '');
    const asked: string[][] = [];
    const live = createCodexLiveness({
      lockDir: dir,
      holders: (paths) => {
        asked.push(paths);
        return `p1220\nf48\nn${join(dir, `${T1}.lock`)}\n`;
      },
    });
    expect(live()).toEqual(new Set([T1]));
    // only thread lock files are probed, by absolute path
    expect([...(asked[0] ?? [])].sort()).toEqual([join(dir, `${T1}.lock`), join(dir, `${T2}.lock`)].sort());
  });

  it('does not spawn lsof at all when there are no thread lock files', () => {
    const dir = lockDir();
    writeFileSync(join(dir, '.coordination.lock'), '');
    let calls = 0;
    const live = createCodexLiveness({ lockDir: dir, holders: () => (calls++, '') });
    expect(live().size).toBe(0);
    expect(calls).toBe(0);
  });

  it('is best-effort: a missing lock dir or a failing lsof yields an empty set', () => {
    const missing = createCodexLiveness({ lockDir: join(tmpdir(), 'anytoany-no-such-dir-xyz'), holders: () => 'n/x/' + T1 + '.lock' });
    expect(missing().size).toBe(0);
    const dir = lockDir();
    writeFileSync(join(dir, `${T1}.lock`), '');
    const broken = createCodexLiveness({
      lockDir: dir,
      holders: () => {
        throw new Error('lsof: command not found');
      },
    });
    expect(broken().size).toBe(0);
  });

  it('caches for the TTL so the dispatch hot path stays cheap', () => {
    const dir = lockDir();
    writeFileSync(join(dir, `${T1}.lock`), '');
    let calls = 0;
    let t = 0;
    const live = createCodexLiveness({ lockDir: dir, ttlMs: 2_000, holders: () => (calls++, `n${T1}.lock`) });
    live(() => t);
    t = 1_999;
    live(() => t);
    expect(calls).toBe(1);
    t = 2_000;
    live(() => t);
    expect(calls).toBe(2);
  });
});
