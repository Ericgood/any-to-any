/**
 * Per-machine delivery policy (~/.anytoany/config.json) — the machine OWNER's
 * explicit escalation choices for headless turns woken by anytoany. Never
 * controlled by the sending agent. Read per delivery so edits apply without
 * a daemon restart.
 */
export interface MachineConfig {
    zcode?: {
        deliverMode?: string;
        deliverTimeoutSec?: number;
    };
    codex?: {
        sandbox?: string;
    };
}
export declare function defaultConfigFile(): string;
export declare function readMachineConfig(file?: string): MachineConfig;
