import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { anytoanyHome } from '../home.js';

const pidFile = (): string => join(anytoanyHome(), '.anytoany', 'daemon.pid');

export function writePid(pid: number = process.pid): void {
  const path = pidFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), 'utf8');
}

export function readPid(): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    rmSync(pidFile());
  } catch {
    /* already gone */
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
