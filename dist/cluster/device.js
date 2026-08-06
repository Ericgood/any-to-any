import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
const DEVICE_FILE = 'device-name';
/** Stable device name: explicit file wins, else hostname's first label. */
export function getDeviceName(home = anytoanyHome()) {
    const path = join(home, '.anytoany', DEVICE_FILE);
    if (existsSync(path)) {
        const name = readFileSync(path, 'utf8').trim();
        if (name)
            return name;
    }
    // Persist the first derivation: macOS hostnames drift (LAN name-conflict
    // suffixes), and the device name is the cluster routing identity.
    const derived = (hostname().split('.')[0] ?? 'device').toLowerCase();
    setDeviceName(derived, home);
    return derived;
}
export function setDeviceName(name, home = anytoanyHome()) {
    mkdirSync(join(home, '.anytoany'), { recursive: true });
    writeFileSync(join(home, '.anytoany', DEVICE_FILE), `${name.trim()}\n`, 'utf8');
}
//# sourceMappingURL=device.js.map