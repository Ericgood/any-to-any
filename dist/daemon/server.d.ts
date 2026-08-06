import type { SessionInfo } from '../adapters/types.js';
import type { Peer } from '../cluster/peers.js';
import type { Mailbox } from '../mailbox/mailbox.js';
export interface ConsoleServerOptions {
    mailbox: Mailbox;
    directory: () => Promise<SessionInfo[]>;
    port?: number;
    /** Poll interval for external mailbox writers (CLI in another process). */
    changePollMs?: number;
    /** LAN peering (Phase 2): serve /api/peer/* and bind 0.0.0.0. */
    peering?: {
        selfDevice: string;
        token: string;
        /** Local-only directory (no peer aggregation) served to peers. */
        localDirectory: () => Promise<SessionInfo[]>;
        /** Live LAN peer list — served to the local CLI/webui at /api/peers. */
        peers?: () => Peer[];
    };
}
export interface RunningServer {
    port: number;
    notifyChange(): void;
    close(): void;
}
/** Local-only web console: REST + SSE + static UI, bound to 127.0.0.1. */
export declare function startConsoleServer(opts: ConsoleServerOptions): RunningServer;
