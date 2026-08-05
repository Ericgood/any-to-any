import { describe, expect, it } from 'vitest';
import { formatRelativeTime, shortenHome } from '../src/format.js';

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats sub-minute as just now', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });
  it('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  it('formats days', () => {
    expect(formatRelativeTime(now - 49 * 3_600_000, now)).toBe('2d ago');
  });
  it('clamps future timestamps', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});

describe('shortenHome', () => {
  it('replaces home prefix with ~', () => {
    expect(shortenHome('/home/u/proj', '/home/u')).toBe('~/proj');
  });
  it('leaves other paths alone', () => {
    expect(shortenHome('/tmp/x', '/home/u')).toBe('/tmp/x');
  });
});
