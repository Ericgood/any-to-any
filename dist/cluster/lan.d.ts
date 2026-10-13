import type { SessionInfo } from '../adapters/types.js';
import type { CollabStore } from '../collab/store.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import { type DeviceIdentity } from './identity.js';
import { type Peer, type PeerRegistry } from './peers.js';
import { type UntrustedContact } from './secure-transport.js';
import { type TrustStore } from './trust.js';
/**
 * The daemon's LAN layer (ADR-002 discovery + ADR-028 identity/encryption):
 * our identity, the trust list, mDNS discovery, the mutual-TLS peer server, and
 * the client side (directory aggregation, relay). Only paired peers are used.
 */
export interface LanOptions {
    selfDevice: string;
    /** Mutual-TLS peer port (console port + 1 by default). */
    peerPort: number;
    mailbox: Mailbox;
    collab?: CollabStore;
    localDirectory: () => Promise<SessionInfo[]>;
    onChange?: () => void;
    /** host:port of peers to add without mDNS (debugging, mDNS-hostile networks). */
    staticPeers?: string[];
    /** Isolated home for tests; defaults to ANYTOANY_HOME / ~. */
    home?: string;
    /** Disable mDNS (tests). */
    mdns?: boolean;
    bindHost?: string;
    log?: (line: string) => void;
}
export interface Lan {
    selfDevice: string;
    identity: DeviceIdentity;
    trust: TrustStore;
    registry: PeerRegistry;
    peerPort: number;
    /** Unpaired devices that contacted us, newest last (pairing requests). */
    pending(): UntrustedContact[];
    /** A paired peer by device name (trusted name or mDNS name). */
    findPeer(device: string): Peer | undefined;
    remoteSessions(): Promise<SessionInfo[]>;
    relay(device: string, message: Message): Promise<{
        ok: boolean;
        error?: string;
    }>;
    stop(): void;
}
export declare function startLan(opts: LanOptions): Promise<Lan>;
