import { describe, expect, it, vi } from 'vitest';
import { createNotifier } from '../src/daemon/notify.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
}));

import { spawn } from 'node:child_process';

describe('notifier', () => {
  it('throttles per session within 60s but allows different sessions', () => {
    let nowMs = 1_000_000;
    const n = createNotifier({ enabled: true, now: () => nowMs });
    n.sessionActivity('codex', 'iOS', 's1', 'received');
    n.sessionActivity('codex', 'iOS', 's1', 'replied'); // throttled
    n.sessionActivity('codex', 'android', 's2', 'received'); // different session — allowed
    expect(vi.mocked(spawn).mock.calls.length).toBe(process.platform === 'darwin' ? 2 : 0);

    nowMs += 61_000;
    n.sessionActivity('codex', 'iOS', 's1', 'received'); // window passed
    expect(vi.mocked(spawn).mock.calls.length).toBe(process.platform === 'darwin' ? 3 : 0);
  });

  it('does nothing when disabled', () => {
    vi.mocked(spawn).mockClear();
    const n = createNotifier({ enabled: false });
    n.sessionActivity('codex', 'x', 's9', 'received');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
  it('alerts on a CLI version mismatch once per agent per 10 minutes (ADR-025)', () => {
    vi.mocked(spawn).mockClear();
    let nowMs = 5_000_000;
    const n = createNotifier({ enabled: true, now: () => nowMs });
    n.versionMismatch('codex', 'version_mismatch: codex CLI 0.157.1 … upgrade: npm i -g @openai/codex@latest');
    n.versionMismatch('codex', 'again'); // throttled — same agent
    n.versionMismatch('claude', 'version_mismatch: claude …'); // other agent — allowed
    const expected = process.platform === 'darwin' ? 2 : 0;
    expect(vi.mocked(spawn).mock.calls.length).toBe(expected);
    if (expected) {
      const script = String(vi.mocked(spawn).mock.calls[0]?.[1]?.[1]);
      expect(script).toContain('npm i -g @openai/codex@latest');
    }
    nowMs += 10 * 60_000 + 1;
    n.versionMismatch('codex', 'later');
    expect(vi.mocked(spawn).mock.calls.length).toBe(process.platform === 'darwin' ? 3 : 0);
  });
});
