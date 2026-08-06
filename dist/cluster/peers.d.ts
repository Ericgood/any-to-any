import type { SessionInfo } from '../adapters/types.js';
import type { Message } from '../mailbox/mailbox.js';
export interface Peer {
    device: string;
    host: string;
    port: number;
    /** Token fingerprint from mDNS TXT — equal to ours means paired. */
    fp: string;
    lastSeenAt: number;
}
export interface PeerRegistry {
    list(): Peer[];
    get(device: string): Peer | undefined;
    /** Manually add a peer (debugging / no-mDNS environments). */
    addStatic(device: string, host: string, port: number, fp: string): void;
    stop(): void;
}
/**
 * Pick the address a LAN peer is actually reachable on. mDNS advertises every
 * interface, including proxy TUN fakes (198.18.0.0/15) and link-local junk —
 * prefer RFC1918 private ranges, never return known-unroutable ranges.
 */
export declare function pickLanAddress(addresses: string[]): string | undefined;
export interface DiscoveryOptions {
    selfDevice: string;
    port: number;
    token: string;
    /** Disable mDNS (tests / --peer only mode). */
    mdns?: boolean;
    /** Browse without announcing — for passive CLI scans that have no real port. */
    publish?: boolean;
}
/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export declare function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry;
/** Pull a peer's local session directory, stamping each entry with its device. */
export declare function fetchPeerSessions(peer: Peer, token: string): Promise<SessionInfo[]>;
/**
 * Hand a message to the peer daemon. Perspective flip: our 'to.device' becomes
 * the peer's local target; our side becomes 'from.device' as seen by them.
 */
export declare function relayToPeer(peer: Peer, message: Message, token: string, selfDevice: string): Promise<{
    ok: boolean;
    error?: string;
}>;
