import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';
const TOKEN_FILE = 'cluster-token';
function tokenPath(home) {
    return join(home, '.anytoany', TOKEN_FILE);
}
/** Shared-secret pairing (ADR-002): same token on every device = one cluster. */
export function loadOrCreateToken(home = anytoanyHome()) {
    const path = tokenPath(home);
    if (existsSync(path))
        return readFileSync(path, 'utf8').trim();
    const token = randomBytes(24).toString('hex');
    mkdirSync(join(home, '.anytoany'), { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return token;
}
export function setToken(token, home = anytoanyHome()) {
    mkdirSync(join(home, '.anytoany'), { recursive: true });
    writeFileSync(tokenPath(home), `${token.trim()}\n`, { mode: 0o600 });
}
/** Short non-secret identifier shown in mDNS TXT to detect pairing state. */
export function tokenFingerprint(token) {
    return createHash('sha256').update(token).digest('hex').slice(0, 8);
}
//# sourceMappingURL=token.js.map