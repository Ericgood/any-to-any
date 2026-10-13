import { describe, expect, it } from 'vitest';
import { formatPeers, formatTrustList, suggestName, type PeersSnapshot } from '../src/cluster/pair-commands.js';

const ID_MINI = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHH';
const ID_LAPTOP = 'ZZZZZZZ-YYYYYYY-XXXXXXX-WWWWWWW-VVVVVVV-UUUUUUU-TTTTTTT-SSS';
const SELF = 'MMMMMMM-NNNNNNN-OOOOOOO-PPPPPPP-QQQQQQQ-RRRRRRR-SSSSSSS-TTT';

const snap = (over: Partial<PeersSnapshot> = {}): PeersSnapshot => ({ lan: true, peers: [], pending: [], ...over });

describe('suggestName', () => {
  it('prefers the mDNS name, then the name it claimed when it knocked, then device-<short id>', () => {
    expect(suggestName(ID_MINI, snap({ peers: [{ device: 'mini', host: 'h', port: 1, id: ID_MINI, lastSeenAt: 0 }] }))).toBe('mini');
    expect(suggestName(ID_MINI, snap({ pending: [{ id: ID_MINI, claimedName: 'mini2', at: 0 }] }))).toBe('mini2');
    expect(suggestName(ID_MINI, null)).toBe('device-aaaaaaa');
  });
});

describe('anyd peers output', () => {
  it('paired / unpaired / pending each say exactly what to do', () => {
    const lines = formatPeers(
      snap({
        peers: [
          { device: 'mini', host: '192.168.1.97', port: 7434, id: ID_MINI, lastSeenAt: 0, paired: true, trustedName: 'mini' },
          { device: 'laptop', host: '192.168.1.50', port: 7434, id: ID_LAPTOP, lastSeenAt: 0, paired: false },
          { device: 'old', host: '192.168.1.9', port: 7433, id: '', lastSeenAt: 0 },
        ],
        pending: [{ id: ID_LAPTOP, claimedName: 'laptop', address: '192.168.1.50', at: 0 }],
      }),
      SELF,
    ).join('\n');
    expect(lines).toContain('@mini  192.168.1.97:7434  paired  AAAAAAA');
    expect(lines).toContain(`anyd pair add ${ID_LAPTOP} --name laptop`);
    expect(lines).toContain('older anytoany');
    expect(lines).toContain('pairing request from laptop (192.168.1.50)');
    expect(lines).toContain(`anyd pair add ${SELF}`);
  });

  it('empty LAN says so', () => {
    expect(formatPeers(snap(), SELF)[0]).toMatch(/no peers found/);
  });
});

describe('anyd pair list', () => {
  it('shows tier owner for your own devices', () => {
    expect(formatTrustList([{ id: ID_MINI, name: 'mini', tier: 'owner', addedAt: Date.UTC(2026, 9, 13) }])).toEqual([
      `@mini  ${ID_MINI}  tier: owner  since 2026-10-13`,
    ]);
    expect(formatTrustList([])[0]).toMatch(/no paired devices/);
  });
});

describe('pair commands against an isolated home (never the real ~/.anytoany)', () => {
  it('add / list / remove / show / invite', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { vi } = await import('vitest');
    const { loadOrCreateIdentity } = await import('../src/cluster/identity.js');
    const cmds = await import('../src/cluster/pair-commands.js');
    const home = mkdtempSync(join(tmpdir(), 'anyd-paircmd-'));
    const other = mkdtempSync(join(tmpdir(), 'anyd-paircmd-other-'));
    const saved = process.env['ANYTOANY_HOME'];
    process.env['ANYTOANY_HOME'] = home;
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    try {
      const self = loadOrCreateIdentity(home);
      const mini = loadOrCreateIdentity(other).id;

      expect(await cmds.addTrusted('not-an-id', { port: 1 })).toBe(false);
      expect(await cmds.addTrusted(self.id, { port: 1 })).toBe(false); // own ID
      // daemon unreachable (port 1) → falls back to device-<short id>
      expect(await cmds.addTrusted(mini.toLowerCase().replace(/-/g, ' '), { port: 1 })).toBe(true);
      expect(out.join('\n')).toContain(`trusted @device-${mini.slice(0, 7).toLowerCase()}`);
      expect(out.join('\n')).toContain(`anyd pair add ${self.id}`); // tells you the other half

      cmds.listTrusted();
      expect(out.join('\n')).toContain('tier: owner');
      expect(cmds.removeTrusted('nope')).toBe(false);
      expect(cmds.removeTrusted(mini)).toBe(true);
      expect(JSON.parse(readFileSync(join(home, '.anytoany', 'trusted-devices.json'), 'utf8')).devices).toEqual([]);

      out.length = 0;
      cmds.showSelf();
      cmds.showInvite();
      const shown = out.join('\n');
      expect(shown).toContain(self.id);
      expect(shown).toContain(`--trust ${self.id}`);
      expect(shown).not.toMatch(/BEGIN (PRIVATE|CERTIFICATE)/); // nothing secret is ever printed
    } finally {
      log.mockRestore();
      err.mockRestore();
      if (saved === undefined) delete process.env['ANYTOANY_HOME'];
      else process.env['ANYTOANY_HOME'] = saved;
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
