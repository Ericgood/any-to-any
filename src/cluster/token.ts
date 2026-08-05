import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = 'cluster-token';

function tokenPath(home: string): string {
  return join(home, '.anytoany', TOKEN_FILE);
}

/** Shared-secret pairing (ADR-002): same token on every device = one cluster. */
export function loadOrCreateToken(home: string = homedir()): string {
  const path = tokenPath(home);
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  mkdirSync(join(home, '.anytoany'), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function setToken(token: string, home: string = homedir()): void {
  mkdirSync(join(home, '.anytoany'), { recursive: true });
  writeFileSync(tokenPath(home), `${token.trim()}\n`, { mode: 0o600 });
}

/** Short non-secret identifier shown in mDNS TXT to detect pairing state. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}
