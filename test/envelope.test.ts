import { describe, expect, it } from 'vitest';
import { extractReply, renderEnvelope, REPLY_MARKER } from '../src/envelope.js';

describe('renderEnvelope', () => {
  const env = renderEnvelope({
    messageId: 'msg-1234',
    fromLabel: '@claude:后端重构',
    text: 'worker.js 的重定向我改成 301 了，帮我跑下路由测试',
  });

  it('identifies the source and message id', () => {
    expect(env).toContain('@claude:后端重构');
    expect(env).toContain('msg-1234');
  });

  it('frames the message as external data, not user instructions', () => {
    expect(env).toMatch(/another AI agent/i);
    expect(env).toMatch(/not .*your own user/i);
    expect(env).toMatch(/do not expand/i);
  });

  it('wraps the body in explicit boundaries', () => {
    expect(env).toContain('--- MESSAGE ---');
    expect(env).toContain('--- END MESSAGE ---');
    expect(env.indexOf('--- MESSAGE ---')).toBeLessThan(env.indexOf('worker.js'));
  });

  it('instructs the reply marker protocol', () => {
    expect(env).toContain(REPLY_MARKER);
  });
});

describe('extractReply', () => {
  it('extracts same-line reply after the marker', () => {
    const out = `did some work\n${REPLY_MARKER} tests all green, 12 passed`;
    expect(extractReply(out)).toBe('tests all green, 12 passed');
  });

  it('extracts multi-line reply following the marker', () => {
    const out = `analysis...\n${REPLY_MARKER}\nline one\nline two`;
    expect(extractReply(out)).toBe('line one\nline two');
  });

  it('uses the LAST marker occurrence (earlier ones may be quoted)', () => {
    const out = `the envelope said ${REPLY_MARKER} example\nreal work\n${REPLY_MARKER} actual reply`;
    expect(extractReply(out)).toBe('actual reply');
  });

  it('returns null when no marker or empty reply', () => {
    expect(extractReply('no marker here')).toBeNull();
    expect(extractReply(`${REPLY_MARKER}   `)).toBeNull();
  });
});
