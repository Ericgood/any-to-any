import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
const MAX_OUTPUT = 10 * 1024 * 1024;
/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), stdin closed (agent CLIs must not wait for piped
 * input), resolving with exit code instead of rejecting.
 */
/**
 * The session's folder, if it still exists. A thread outlives its project folder
 * being moved or deleted, and spawning into a missing cwd fails with a misleading
 * "spawn <cmd> ENOENT" — it reads as "CLI not installed" (2026-10-25 incident).
 */
export function existingDir(dir) {
    try {
        return dir && existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
    }
    catch {
        return undefined;
    }
}
export const realExec = (cmd, args, opts) => new Promise((resolve) => {
    if (opts.cwd && !existingDir(opts.cwd)) {
        resolve({
            stdout: '',
            stderr: `working directory does not exist: ${opts.cwd} (the session's project folder was moved or deleted)`,
            code: 127,
        });
        return;
    }
    const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, extraErr = '') => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + extraErr, code });
    };
    const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(124, `\ntimeout after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => {
        if (stdout.length < MAX_OUTPUT)
            stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
        if (stderr.length < MAX_OUTPUT)
            stderr += d.toString();
    });
    child.on('error', (e) => finish(127, e.message));
    child.on('close', (code) => finish(code ?? 1));
});
//# sourceMappingURL=exec.js.map