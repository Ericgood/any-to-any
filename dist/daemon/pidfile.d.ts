export declare function writePid(pid?: number): void;
export declare function readPid(): number | null;
/** Remove the pid file. With ownPid, only if this process is the recorded owner. */
export declare function clearPid(ownPid?: number): void;
export declare function isAlive(pid: number): boolean;
