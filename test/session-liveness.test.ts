import { describe, expect, it } from 'vitest';
import { parseLiveClaudeSessions } from '../src/daemon/session-liveness.js';

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
