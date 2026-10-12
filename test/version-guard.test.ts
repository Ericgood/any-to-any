import { describe, expect, it } from 'vitest';
import type { ExecFn } from '../src/adapters/types.js';
import {
  VERSION_MISMATCH,
  checkCliVersion,
  createVersionProbe,
  inferWriterVersion,
  isCliOlder,
  parseVersion,
} from '../src/adapters/version-guard.js';

describe('parseVersion', () => {
  it('reads the numeric core from real CLI / session strings', () => {
    expect(parseVersion('2.1.296 (Claude Code)')).toEqual([2, 1, 296]);
    expect(parseVersion('codex-cli 0.157.1')).toEqual([0, 157, 1]);
    expect(parseVersion('0.162.0-alpha.17.2')).toEqual([0, 162, 0]);
  });

  it('returns null for anything without x.y.z', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('BRAVO')).toBeNull();
    expect(parseVersion('v2.1')).toBeNull();
  });
});

describe('isCliOlder', () => {
  it('flags a CLI older than the session writer', () => {
    expect(isCliOlder('2.1.287', '2.1.295')).toBe(true);
    expect(isCliOlder('codex-cli 0.157.1', '0.162.0-alpha.17.2')).toBe(true);
    expect(isCliOlder('1.9.9', '2.0.0')).toBe(true);
  });

  it('lets a newer or equal CLI through — only the old→new direction breaks', () => {
    expect(isCliOlder('2.1.296', '2.1.295')).toBe(false);
    expect(isCliOlder('2.1.295', '2.1.295')).toBe(false);
    // prerelease suffix is ignored: npm `latest` 0.162.1 can resume a 0.162.0-alpha session
    expect(isCliOlder('0.162.1', '0.162.0-alpha.17.2')).toBe(false);
    expect(isCliOlder('0.162.0', '0.162.0-alpha.17.2')).toBe(false);
  });

  it('never blocks on an unparseable side', () => {
    expect(isCliOlder('garbage', '2.1.295')).toBe(false);
    expect(isCliOlder('2.1.287', '')).toBe(false);
  });
});

function countingExec(stdout: string, code = 0) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout, stderr: '', code };
  };
  return { exec, calls };
}

describe('createVersionProbe', () => {
  it('runs `<cmd> --version` and caches the result within the TTL', async () => {
    const { exec, calls } = countingExec('2.1.296 (Claude Code)\n');
    let t = 0;
    const probe = createVersionProbe(exec, 'claude', { ttlMs: 60_000, now: () => t });
    expect(await probe()).toBe('2.1.296 (Claude Code)');
    t = 59_999;
    await probe();
    expect(calls).toEqual([['claude', '--version']]);
  });

  it('re-probes after the TTL so an upgrade takes effect without a daemon restart', async () => {
    const { exec, calls } = countingExec('2.1.296');
    let t = 0;
    const probe = createVersionProbe(exec, 'claude', { ttlMs: 60_000, now: () => t });
    await probe();
    t = 60_001;
    await probe();
    expect(calls).toHaveLength(2);
  });

  it('returns null when the CLI is missing or errors', async () => {
    const { exec } = countingExec('', 127);
    const probe = createVersionProbe(exec, 'codex', { now: () => 0 });
    expect(await probe()).toBeNull();
  });
});

describe('checkCliVersion', () => {
  const spec = { cli: 'codex', app: 'Codex Desktop', upgrade: 'npm i -g @openai/codex@latest' };

  it('returns an actionable version_mismatch error when the CLI is older', async () => {
    const err = await checkCliVersion(async () => 'codex-cli 0.157.1', spec, '0.162.0-alpha.17.2');
    expect(err).not.toBeNull();
    expect(err!.startsWith(VERSION_MISMATCH)).toBe(true);
    expect(err).toContain('0.157.1');
    expect(err).toContain('0.162.0-alpha.17.2');
    expect(err).toContain('npm i -g @openai/codex@latest');
  });

  it('passes when versions are compatible', async () => {
    expect(await checkCliVersion(async () => 'codex-cli 0.162.1', spec, '0.162.0-alpha.17.2')).toBeNull();
  });

  it('skips the probe entirely when the session has no recorded writer version', async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return '0.1.0';
    };
    expect(await checkCliVersion(probe, spec, undefined)).toBeNull();
    expect(probed).toBe(false);
  });

  it('passes when the CLI version cannot be determined', async () => {
    expect(await checkCliVersion(async () => null, spec, '0.162.0')).toBeNull();
  });
});

describe('inferWriterVersion', () => {
  const samples = [
    { originator: 'Codex Desktop', version: '0.162.0-alpha.17.2', at: 100 },
    { originator: 'Codex Desktop', version: '0.150.0', at: 50 },
    { originator: 'codex-tui', version: '0.170.0', at: 10 },
  ];
  it('takes the highest same-originator version seen up to lastActiveAt', () => {
    expect(inferWriterVersion('0.144.2', 'Codex Desktop', 100, samples)).toBe('0.162.0-alpha.17.2');
    expect(inferWriterVersion('0.144.2', 'Codex Desktop', 99, samples)).toBe('0.150.0');
  });
  it('never goes below the session\'s own record, and ignores other originators', () => {
    expect(inferWriterVersion('0.165.0', 'Codex Desktop', 100, samples)).toBe('0.165.0');
    expect(inferWriterVersion('0.144.2', 'Codex Desktop', 20, samples)).toBe('0.144.2');
  });
  it('without an originator, keeps the own record', () => {
    expect(inferWriterVersion('0.144.2', undefined, 1e15, samples)).toBe('0.144.2');
    expect(inferWriterVersion(undefined, undefined, 1e15, samples)).toBeUndefined();
  });
});
