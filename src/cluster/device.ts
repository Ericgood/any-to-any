import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';

const DEVICE_FILE = 'device-name';

/** Stable device name: explicit file wins, else hostname's first label. */
export function getDeviceName(home: string = anytoanyHome()): string {
  const path = join(home, '.anytoany', DEVICE_FILE);
  if (existsSync(path)) {
    const name = readFileSync(path, 'utf8').trim();
    if (name) return name;
  }
  return (hostname().split('.')[0] ?? 'device').toLowerCase();
}

export function setDeviceName(name: string, home: string = anytoanyHome()): void {
  mkdirSync(join(home, '.anytoany'), { recursive: true });
  writeFileSync(join(home, '.anytoany', DEVICE_FILE), `${name.trim()}\n`, 'utf8');
}
