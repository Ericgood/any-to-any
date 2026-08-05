import { spawn } from 'node:child_process';
import type { ExecFn } from './types.js';

const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), stdin closed (agent CLIs must not wait for piped
 * input), resolving with exit code instead of rejecting.
 */
export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number, extraErr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + extraErr, code });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124, `\ntimeout after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on('error', (e) => finish(127, e.message));
    child.on('close', (code) => finish(code ?? 1));
  });
