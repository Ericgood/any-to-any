import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from './home.js';

/**
 * Per-machine delivery policy (~/.anytoany/config.json) — the machine OWNER's
 * explicit escalation choices for headless turns woken by anytoany. Never
 * controlled by the sending agent. Read per delivery so edits apply without
 * a daemon restart.
 */
export interface MachineConfig {
  zcode?: { deliverMode?: string; deliverTimeoutSec?: number };
  codex?: { sandbox?: string; deliverTimeoutSec?: number };
  /** Self-driving collaboration loop (ADR-020). All optional; safe defaults
   *  (enabled, 60s cadence, 2 self-retries, 1h ceiling). Set enabled:false to
   *  turn the whole auto-driver off. */
  autorun?: {
    enabled?: boolean;
    tickIntervalSec?: number;
    maxRetries?: number;
    maxWallClockSec?: number;
  };
}

export function defaultConfigFile(): string {
  return join(anytoanyHome(), '.anytoany', 'config.json');
}

export function readMachineConfig(file: string = defaultConfigFile()): MachineConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as MachineConfig;
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    return {}; // no config / unreadable — safe defaults everywhere
  }
}
