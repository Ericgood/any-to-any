import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
const FILE = 'trusted-devices.json';
function isTrustedDevice(v) {
    const d = v;
    return typeof d?.id === 'string' && typeof d.name === 'string' && d.tier === 'owner';
}
/** Re-reads the file when its mtime changes, so `anyd pair add` applies to a running daemon. */
export function createTrustStore(home = anytoanyHome()) {
    const dir = join(home, '.anytoany');
    const path = join(dir, FILE);
    let cache = null;
    const read = () => {
        if (!existsSync(path))
            return [];
        const mtimeMs = statSync(path).mtimeMs;
        if (cache && cache.mtimeMs === mtimeMs)
            return cache.devices;
        let devices = [];
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            devices = (parsed.devices ?? []).filter(isTrustedDevice);
        }
        catch {
            devices = []; // corrupt file: trust nobody rather than crash the daemon
        }
        cache = { mtimeMs, devices };
        return devices;
    };
    const write = (devices) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        cache = null;
    };
    const byName = (name) => read().find((d) => d.name.toLowerCase() === name.toLowerCase());
    return {
        list: read,
        get: (id) => read().find((d) => d.id === id),
        byName,
        add({ id, name }) {
            const existing = read().find((d) => d.id === id);
            const entry = existing
                ? { ...existing, name }
                : { id, name, tier: 'owner', addedAt: Date.now() };
            write([...read().filter((d) => d.id !== id), entry]);
            return entry;
        },
        remove(idOrName) {
            const target = read().find((d) => d.id === idOrName) ?? byName(idOrName);
            if (!target)
                return false;
            write(read().filter((d) => d.id !== target.id));
            return true;
        },
    };
}
//# sourceMappingURL=trust.js.map