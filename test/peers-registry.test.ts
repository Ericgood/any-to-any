import { describe, expect, it, vi } from 'vitest';

const { publishMock, findMock, updateMock } = vi.hoisted(() => {
  const updateMock = vi.fn();
  return {
    publishMock: vi.fn(),
    updateMock,
    findMock: vi.fn(() => ({ on: vi.fn(), update: updateMock })),
  };
});

vi.mock('bonjour-service', () => ({
  Bonjour: vi.fn(() => ({ publish: publishMock, find: findMock, destroy: vi.fn() })),
}));

import { Bonjour } from 'bonjour-service';
import { pickLanAddress, startPeerRegistry } from '../src/cluster/peers.js';

describe('peer registry mDNS behaviour', () => {
  it('daemon mode announces itself with its real port', () => {
    publishMock.mockClear();
    const r = startPeerRegistry({ selfDevice: 'macbook', port: 7433, token: 't' });
    expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ port: 7433 }));
    r.stop();
  });

  it('publisher and browser use separate mDNS instances — a shared socket starves browser queries', () => {
    vi.mocked(Bonjour).mockClear();
    const r = startPeerRegistry({ selfDevice: 'macbook', port: 7433, token: 't' });
    expect(vi.mocked(Bonjour)).toHaveBeenCalledTimes(2);
    r.stop();
  });

  it('re-queries periodically — the initial browser query can be silently lost', () => {
    vi.useFakeTimers();
    try {
      updateMock.mockClear();
      const r = startPeerRegistry({ selfDevice: 'macbook', port: 7433, token: 't' });
      vi.advanceTimersByTime(31_000);
      expect(updateMock).toHaveBeenCalled();
      r.stop();
      updateMock.mockClear();
      vi.advanceTimersByTime(61_000);
      expect(updateMock).not.toHaveBeenCalled(); // stop() clears the timer
    } finally {
      vi.useRealTimers();
    }
  });

  it('browse-only mode never publishes (CLI passive scan may pass port 0)', () => {
    publishMock.mockClear();
    vi.mocked(Bonjour).mockClear();
    const r = startPeerRegistry({ selfDevice: 'macbook', port: 0, token: 't', publish: false });
    expect(publishMock).not.toHaveBeenCalled();
    expect(findMock).toHaveBeenCalled();
    expect(vi.mocked(Bonjour)).toHaveBeenCalledTimes(1);
    r.stop();
  });
});

describe('peer rename dedup', () => {
  it('drops a stale alias when the same host:port reappears under a new name', () => {
    const onMock = vi.fn();
    findMock.mockReturnValueOnce({ on: onMock, update: updateMock });
    const r = startPeerRegistry({ selfDevice: 'macbook', port: 0, token: 't', publish: false });
    const up = onMock.mock.calls.find((c) => c[0] === 'up')?.[1] as (s: unknown) => void;
    const svc = (device: string) => ({
      txt: { device, fp: 'aa' },
      addresses: ['192.168.1.97'],
      port: 7433,
    });
    up(svc('desktop-7f3a'));
    up(svc('mini'));
    expect(r.list().map((p) => p.device)).toEqual(['mini']);
    r.stop();
  });
});

describe('pickLanAddress', () => {
  it('prefers RFC1918 over proxy TUN fakes regardless of order (real mini advert)', () => {
    expect(
      pickLanAddress(['198.18.0.1', '192.168.1.97', 'fe80::84a:3d3d', '2408:824e::1']),
    ).toBe('192.168.1.97');
    expect(pickLanAddress(['192.168.1.97', '198.18.0.1'])).toBe('192.168.1.97');
  });

  it('never returns benchmark/link-local/loopback ranges', () => {
    expect(pickLanAddress(['198.18.0.1'])).toBeUndefined();
    expect(pickLanAddress(['198.19.5.5', '169.254.1.2', '127.0.0.1'])).toBeUndefined();
  });

  it('supports 10.x and 172.16-31.x private ranges', () => {
    expect(pickLanAddress(['198.18.0.1', '10.0.1.5'])).toBe('10.0.1.5');
    expect(pickLanAddress(['172.20.0.3'])).toBe('172.20.0.3');
    expect(pickLanAddress(['172.32.0.3', '8.8.8.8'])).toBe('172.32.0.3'); // public fallback when no private
  });

  it('returns undefined for empty or IPv6-only lists', () => {
    expect(pickLanAddress([])).toBeUndefined();
    expect(pickLanAddress(['fe80::1', '2408:824e::9'])).toBeUndefined();
  });
});
