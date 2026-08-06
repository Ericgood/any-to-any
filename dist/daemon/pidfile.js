import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { anytoanyHome } from '../home.js';
const pidFile = () => join(anytoanyHome(), '.anytoany', 'daemon.pid');
export function writePid(pid = process.pid) {
    const path = pidFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(pid), 'utf8');
}
export function readPid() {
    try {
        const n = Number.parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
        return Number.isFinite(n) ? n : null;
    }
    catch {
        return null;
    }
}
/** Remove the pid file. With ownPid, only if this process is the recorded owner. */
export function clearPid(ownPid) {
    try {
        if (ownPid !== undefined && readPid() !== ownPid)
            return;
        rmSync(pidFile());
    }
    catch {
        /* already gone */
    }
}
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=pidfile.js.map