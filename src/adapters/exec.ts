import { execFile } from 'node:child_process';
import type { ExecFn } from './types.js';

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), resolving with exit code instead of rejecting.
 */
export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      },
    );
    child.on('error', () => {
      /* handled via callback error above */
    });
  });
