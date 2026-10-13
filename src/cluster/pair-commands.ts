import { getDeviceName } from './device.js';
import { loadOrCreateIdentity, normalizeDeviceId, shortDeviceId } from './identity.js';
import { startPeerRegistry, type Peer } from './peers.js';
import type { UntrustedContact } from './secure-transport.js';
import { createTrustStore, type TrustedDevice } from './trust.js';

/**
 * `anyd pair` / `anyd peers` (ADR-028). Pairing is Syncthing's: each side adds the
 * other's public device ID. Nothing secret is ever printed or pasted.
 */

const INSTALL_URL = 'https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh';

/** What the running daemon reports at /api/peers. */
export interface PeersSnapshot {
  lan: boolean;
  self?: { device: string; id: string } | null;
  peers: Array<Peer & { paired?: boolean; trustedName?: string }>;
  pending?: UntrustedContact[];
}

async function fetchSnapshot(port: number): Promise<PeersSnapshot | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/peers`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as PeersSnapshot) : null;
  } catch {
    return null; // daemon not running
  }
}

/** Name for a newly trusted device: explicit > what it announced/claimed > device-<short id>. */
export function suggestName(id: string, snapshot: PeersSnapshot | null): string {
  const seen = snapshot?.peers.find((p) => p.id === id)?.device;
  const claimed = snapshot?.pending?.find((c) => c.id === id)?.claimedName;
  return seen ?? claimed ?? `device-${shortDeviceId(id).toLowerCase()}`;
}

export function showSelf(): void {
  const { id } = loadOrCreateIdentity();
  const name = getDeviceName();
  console.log(`device: ${name}`);
  console.log(`id:     ${id}`);
  console.log(`\nThis ID is public — sharing it is safe. To pair with another device of yours:`);
  console.log(`  on the other device:  anyd pair add ${id} --name ${name}`);
  console.log(`  then here:            anyd pair add <its id>        (\`anyd peers\` shows it)`);
  console.log(`New device without anytoany yet?  anyd pair --invite`);
}

export function showInvite(): void {
  const { id } = loadOrCreateIdentity();
  const name = getDeviceName();
  console.log(`Paste this into the other device's terminal — or hand it to any agent there:\n`);
  console.log(`  curl -fsSL ${INSTALL_URL} | bash -s -- --trust ${id} --trust-name ${name}\n`);
  console.log(`It installs anytoany, trusts this device, and prints its own ID.`);
  console.log(`Then, back here:  anyd pair add <the ID it printed>`);
  console.log(`(Only public IDs are exchanged — nothing in this command is secret. ADR-028)`);
}

export async function addTrusted(rawId: string, opts: { name?: string; port: number }): Promise<boolean> {
  const id = normalizeDeviceId(rawId);
  if (!id) {
    console.error(`error: "${rawId}" is not a device ID (52 letters/digits, e.g. ABCDEFG-HIJKLMN-…). Run \`anyd pair\` on the other device to see it.`);
    return false;
  }
  const self = loadOrCreateIdentity();
  if (id === self.id) {
    console.error('error: that is this device’s own ID — run `anyd pair add` with the OTHER device’s ID');
    return false;
  }
  const name = opts.name ?? suggestName(id, await fetchSnapshot(opts.port));
  const entry = createTrustStore().add({ id, name });
  console.log(`trusted @${entry.name} (${entry.id}) — tier: owner (your own device; its messages carry your authority)`);
  console.log(`The other device must also trust this one:  anyd pair add ${self.id} --name ${getDeviceName()}`);
  console.log('A running daemon picks this up immediately — no restart needed.');
  return true;
}

export function removeTrusted(idOrName: string): boolean {
  const key = normalizeDeviceId(idOrName) ?? idOrName;
  if (!createTrustStore().remove(key)) {
    console.error(`error: no paired device matches "${idOrName}" (anyd pair list)`);
    return false;
  }
  console.log(`removed ${idOrName} — it can no longer talk to this device`);
  return true;
}

export function formatTrustList(devices: TrustedDevice[]): string[] {
  if (devices.length === 0) return ['no paired devices — anyd pair shows how to add one'];
  return devices.map((d) => `@${d.name}  ${d.id}  tier: ${d.tier}  since ${new Date(d.addedAt).toISOString().slice(0, 10)}`);
}

export function listTrusted(): void {
  for (const line of formatTrustList(createTrustStore().list())) console.log(line);
}

/** `anyd peers` lines: discovered devices, their pairing state, and pending requests. */
export function formatPeers(snapshot: PeersSnapshot, selfId: string): string[] {
  const lines: string[] = [];
  for (const p of snapshot.peers) {
    if (p.paired) {
      lines.push(`@${p.trustedName ?? p.device}  ${p.host}:${p.port}  paired  ${shortDeviceId(p.id)}`);
    } else if (!p.id) {
      lines.push(`@${p.device}  ${p.host}:${p.port}  older anytoany (no device ID) — upgrade it to pair`);
    } else {
      lines.push(`@${p.device}  ${p.host}:${p.port}  NOT paired — to trust it: anyd pair add ${p.id} --name ${p.device}`);
    }
  }
  for (const c of snapshot.pending ?? []) {
    lines.push(
      `pairing request from ${c.claimedName ?? 'unknown device'}${c.address ? ` (${c.address})` : ''}: ${c.id}` +
        `\n  if that is yours: anyd pair add ${c.id}${c.claimedName ? ` --name ${c.claimedName}` : ''}`,
    );
  }
  if (lines.length === 0) lines.push('no peers found (is anyd start running on the other device? same network?)');
  lines.push(`(this device: ${selfId} — the other side adds it with: anyd pair add ${selfId})`);
  return lines;
}

export async function showPeers(port: number): Promise<void> {
  const self = loadOrCreateIdentity();
  let snapshot = await fetchSnapshot(port);
  if (snapshot && !snapshot.lan) {
    console.log('daemon is running with LAN peering disabled (--no-lan)');
    return;
  }
  if (!snapshot) {
    const registry = startPeerRegistry({ selfDevice: getDeviceName(), selfId: self.id, port: 0, publish: false });
    console.log('daemon not reachable — passive mDNS scan for 3s…');
    await new Promise((r) => setTimeout(r, 3000));
    const trust = createTrustStore();
    snapshot = {
      lan: true,
      peers: registry.list().map((p) => {
        const t = p.id ? trust.get(p.id) : undefined;
        return { ...p, paired: Boolean(t), ...(t ? { trustedName: t.name } : {}) };
      }),
    };
    registry.stop();
  }
  console.log(`self: @${getDeviceName()}`);
  for (const line of formatPeers(snapshot, self.id)) console.log(line);
}
