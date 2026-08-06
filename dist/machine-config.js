import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from './home.js';
export function defaultConfigFile() {
    return join(anytoanyHome(), '.anytoany', 'config.json');
}
export function readMachineConfig(file = defaultConfigFile()) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return typeof raw === 'object' && raw !== null ? raw : {};
    }
    catch {
        return {}; // no config / unreadable — safe defaults everywhere
    }
}
//# sourceMappingURL=machine-config.js.map