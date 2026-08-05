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
});
