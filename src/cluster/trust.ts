import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';

/**
 * Who this device trusts (ADR-028). Syncthing-style: a list of device IDs added by
 * hand on both sides. Revoking one device = removing one entry — no shared secret
 * to rotate across the cluster.
 *
 * Tiers: only `owner` exists — the operator's own devices, whose messages carry the
 * operator's authority (ADR-016). A future `guest` tier (someone else's device)
 * would deliver data, never commands; it is deliberately not addable yet.
 */

export type TrustTier = 'owner';

export interface TrustedDevice {
  id: string;
  name: string;
  tier: TrustTier;
  addedAt: number;
}

export interface TrustStore {
  list(): TrustedDevice[];
  get(id: string): TrustedDevice | undefined;
  byName(name: string): TrustedDevice | undefined;
  /** Add (or rename) an owner-tier device. */
  add(device: { id: string; name: string }): TrustedDevice;
  /** Remove by device ID or name. false = nothing matched. */
  remove(idOrName: string): boolean;
}

const FILE = 'trusted-devices.json';

function isTrustedDevice(v: unknown): v is TrustedDevice {
  const d = v as Partial<TrustedDevice>;
  return typeof d?.id === 'string' && typeof d.name === 'string' && d.tier === 'owner';
}

/** Re-reads the file when its mtime changes, so `anyd pair add` applies to a running daemon. */
export function createTrustStore(home: string = anytoanyHome()): TrustStore {
  const dir = join(home, '.anytoany');
  const path = join(dir, FILE);
  let cache: { mtimeMs: number; devices: TrustedDevice[] } | null = null;

  const read = (): TrustedDevice[] => {
    if (!existsSync(path)) return [];
    const mtimeMs = statSync(path).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.devices;
    let devices: TrustedDevice[] = [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown[] };
      devices = (parsed.devices ?? []).filter(isTrustedDevice);
    } catch {
      devices = []; // corrupt file: trust nobody rather than crash the daemon
    }
    cache = { mtimeMs, devices };
    return devices;
  };

  const write = (devices: TrustedDevice[]): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    cache = null;
  };

  const byName = (name: string) => read().find((d) => d.name.toLowerCase() === name.toLowerCase());

  return {
    list: read,
    get: (id) => read().find((d) => d.id === id),
    byName,
    add({ id, name }) {
      const existing = read().find((d) => d.id === id);
      const entry: TrustedDevice = existing
        ? { ...existing, name }
        : { id, name, tier: 'owner', addedAt: Date.now() };
      write([...read().filter((d) => d.id !== id), entry]);
      return entry;
    },
    remove(idOrName) {
      const target = read().find((d) => d.id === idOrName) ?? byName(idOrName);
      if (!target) return false;
      write(read().filter((d) => d.id !== target.id));
      return true;
    },
  };
}
