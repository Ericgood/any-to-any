import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'anytoany-pid-'));

beforeAll(() => {
  process.env.ANYTOANY_HOME = home;
});
afterAll(() => {
  delete process.env.ANYTOANY_HOME;
  rmSync(home, { recursive: true, force: true });
});

import { clearPid, isAlive, readPid, writePid } from '../src/daemon/pidfile.js';

describe('pid file ownership', () => {
  it('round-trips a pid and checks liveness', () => {
    writePid(123);
    expect(readPid()).toBe(123);
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999999)).toBe(false);
  });

  it("an exiting process must not clobber another daemon's pid file", () => {
    writePid(123);
    clearPid(456); // crashed starter's exit handler — not the owner
    expect(readPid()).toBe(123);
    clearPid(123); // the owner exits
    expect(readPid()).toBeNull();
  });

  it('unconditional clear still works (anyd stop cleanup)', () => {
    writePid(789);
    clearPid();
    expect(readPid()).toBeNull();
  });
});
