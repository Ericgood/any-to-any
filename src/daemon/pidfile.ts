import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PID_FILE = join(homedir(), '.anytoany', 'daemon.pid');

export function writePid(pid: number = process.pid): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf8');
}

export function readPid(): number | null {
  try {
    const n = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    rmSync(PID_FILE);
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
