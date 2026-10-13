import type { SessionInfo } from '../adapters/types.js';
import type { CollabStore } from '../collab/store.js';
import type { Peer } from '../cluster/peers.js';
import type { UntrustedContact } from '../cluster/secure-transport.js';
import type { TrustStore } from '../cluster/trust.js';
import type { Mailbox } from '../mailbox/mailbox.js';
export interface ConsoleServerOptions {
    mailbox: Mailbox;
    directory: () => Promise<SessionInfo[]>;
    port?: number;
    /** Collaboration-doc store (Phase 4) — surfaced read-only in the console. */
    collab?: CollabStore;
    /** Poll interval for external mailbox writers (CLI in another process). */
    changePollMs?: number;
    /** Root for the external-agent registry (ADR-024); defaults to ~. Injectable for tests. */
    registryHome?: string;
    /** Drop the caller's directory cache. Called when an external agent registers,
     *  so it is addressable immediately instead of after the cache TTL — otherwise
     *  the first reply to a just-registered agent fails with a confusing not_found. */
    invalidateDirectory?: () => void;
    /** Pre-send check for a LOCAL target (ADR-025): non-null = refuse the send with
     *  409 and queue nothing, so the sender sees e.g. a CLI version mismatch now —
     *  instead of a silent dead letter whose cause the pull-hook recovery hides. */
    preflight?: (session: SessionInfo) => Promise<string | null>;
    /** LAN peering status for /api/peers. The peer API itself is served by the
     *  separate mutual-TLS peer server (ADR-028); this console stays loopback-only. */
    peering?: {
        selfDevice: string;
        selfId: string;
        /** Live LAN peer list (mDNS + static). */
        peers?: () => Peer[];
        trust?: TrustStore;
        /** Devices with a valid certificate that tried to talk to us but aren't paired. */
        pending?: () => UntrustedContact[];
    };
}
export interface RunningServer {
    port: number;
    notifyChange(): void;
    close(): void;
}
/** Local-only web console: REST + SSE + static UI, bound to 127.0.0.1. */
export declare function startConsoleServer(opts: ConsoleServerOptions): RunningServer;
