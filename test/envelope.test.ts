import { describe, expect, it } from 'vitest';
import { extractReply, renderEnvelope, REPLY_MARKER } from '../src/envelope.js';

describe('renderEnvelope', () => {
  const env = renderEnvelope({
    messageId: 'msg-1234',
    fromLabel: '@claude:backend refactor',
    text: 'changed the worker.js redirect to 301, please run the routing tests',
  });

  it('identifies the source and message id', () => {
    expect(env).toContain('@claude:backend refactor');
    expect(env).toContain('msg-1234');
  });

  it('frames the sender as a trusted teammate in the operator\'s own cluster (ADR-016)', () => {
    expect(env).toMatch(/your operator/i);
    expect(env).toMatch(/cluster/i);
    expect(env).toMatch(/teammate/i);
    // the request carries the operator's delegated authority
    expect(env).toMatch(/authority|authoriz|go-ahead|delegat/i);
  });

  it('forbids refusing on trust grounds — relayed authorization IS the operator\'s go-ahead', () => {
    expect(env).toMatch(/do not refuse merely|not refuse.*because it came from another agent/i);
    expect(env).toMatch(/relay/i);
    // must NOT carry the old "untrusted external data / do not expand permissions" framing
    expect(env).not.toMatch(/do not expand your permissions/i);
    expect(env).not.toMatch(/treat it as external data/i);
  });

  it('preserves autonomy: propose alternatives, flag genuinely destructive actions', () => {
    expect(env).toMatch(/autonomy|good faith/i);
    expect(env).toMatch(/destructive|irreversib/i);
  });

  it('wraps the body in explicit boundaries', () => {
    expect(env).toContain('--- MESSAGE ---');
    expect(env).toContain('--- END MESSAGE ---');
    expect(env.indexOf('--- MESSAGE ---')).toBeLessThan(env.indexOf('worker.js'));
  });

  it('instructs the reply marker protocol', () => {
    expect(env).toContain(REPLY_MARKER);
  });

  it('forces a status verdict in the only turn (no acknowledgement-only replies)', () => {
    expect(env).toMatch(/ONLY TURN/i);
    expect(env).toContain('DONE');
    expect(env).toContain('BLOCKED');
    expect(env).toContain('DECLINED');
    expect(env).toMatch(/Acknowledgement-only.*NOT valid/i);
    expect(env).toMatch(/exempt from\s*.*anti-chatter/i);
  });
});

describe('renderEnvelope — collab footer (Phase 4)', () => {
  it('omits the shared-plan footer when no collab doc is attached', () => {
    const env = renderEnvelope({ messageId: 'm', fromLabel: '@a:x', text: 'hi' });
    expect(env).not.toContain('SHARED PLAN');
  });

  it('points the recipient at the doc with its own label and ready-to-run commands', () => {
    const env = renderEnvelope({
      messageId: 'm',
      fromLabel: '@claude:web-app',
      text: 'take t1',
      collab: { conversationId: 'conv-abc', selfLabel: '@codex:api' },
    });
    expect(env).toContain('--- SHARED PLAN ---');
    expect(env).toContain('anyd collab show conv-abc');
    expect(env).toContain('anyd collab progress conv-abc --as "@codex:api"');
    // the footer sits after the message body
    expect(env.indexOf('--- END MESSAGE ---')).toBeLessThan(env.indexOf('SHARED PLAN'));
    // still carries the verdict protocol
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
