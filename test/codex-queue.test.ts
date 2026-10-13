import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../src/adapters/codex.js';
import type { ExecFn, SessionInfo } from '../src/adapters/types.js';
import { REPLY_MARKER, renderEnvelope } from '../src/envelope.js';

// ADR-027, verified 2026-10-13 on a throwaway thread: with Codex Desktop holding
// the thread's writer lock, `codex queue` lands the message in Desktop's own
// queue (~/.codex/queue_1.sqlite) and Desktop runs it within ~4s.
const THREAD = '01a1358c-0aeb-7b50-8d1c-d25a60e3d8a1';
const NO_CONFIG = '/nonexistent/anytoany-config.json';

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  agent: 'codex',
  sessionId: THREAD,
  title: 't',
  cwd: '/w/proj',
  lastActiveAt: 0,
  ...over,
});

function recordingExec(reply: { stdout?: string; stderr?: string; code?: number }) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', code: reply.code ?? 0 };
  };
  return { exec, calls };
}

describe('codex delivery into a thread Codex Desktop holds open (ADR-027)', () => {
  const live = () => true;

  it('queues the envelope with `codex queue` instead of a headless resume', async () => {
    const { exec, calls } = recordingExec({ stdout: `Queued message 01a1358e-552a for thread ${THREAD}.\n` });
    const adapter = createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: live });
    const r = await adapter.deliver(session(), 'ENVELOPE');
    expect(r).toEqual({ ok: true, output: '' });
    expect(calls).toEqual([['codex', 'queue', '--thread', THREAD, '--message', 'ENVELOPE']]);
  });

  it('is exempt from the version guard — it only appends to a queue, verified across 0.157 → 0.162', async () => {
    const { exec, calls } = recordingExec({ stdout: 'Queued message x for thread y.' });
    const adapter = createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: live });
    expect(await adapter.preflight!(session({ writerVersion: '0.162.0-alpha.17.2' }))).toBeNull();
    expect(calls.some((c) => c.includes('--version'))).toBe(false);
  });

  it('a failed queue is a retryable error naming the command', async () => {
    const { exec } = recordingExec({ code: 1, stderr: 'error: unknown thread' });
    const adapter = createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: live });
    const r = await adapter.deliver(session(), 'ENVELOPE');
    expect(r.ok).toBe(false);
    expect(r.retry).not.toBe(false);
    expect(r.error).toContain('codex queue');
    expect(r.error).toContain('unknown thread');
  });

  it('asks for command-style replies when queueing (no stdout to read a marker from)', () => {
    const adapter = createCodexAdapter({ configFile: NO_CONFIG, isThreadLive: live });
    expect(adapter.replyChannel?.(session())).toBe('command');
  });
});

describe('codex delivery into a thread nobody holds — unchanged', () => {
  it('still uses `codex exec resume` and marker replies', async () => {
    const { exec, calls } = recordingExec({ stdout: 'BRAVO' });
    const adapter = createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: () => false });
    await adapter.deliver(session(), 'ENVELOPE');
    expect(calls[0]?.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    expect(adapter.replyChannel?.(session())).toBe('marker');
  });
});

describe('envelope reply channel', () => {
  const base = { messageId: 'abc123', fromLabel: '@claude:a', text: 'do X' };

  it('marker (default): status lines use the reply marker', () => {
    const env = renderEnvelope(base);
    expect(env).toContain(`${REPLY_MARKER} DONE`);
  });

  it('command: tells the agent to run `anyd reply <id>` and never mentions the marker', () => {
    const env = renderEnvelope({ ...base, replyVia: 'command' });
    expect(env).toContain('anyd reply abc123 "DONE');
    expect(env).toContain('anyd reply abc123 "NOOP"');
    expect(env).not.toContain(REPLY_MARKER);
    expect(env).toContain('do X');
  });
});
