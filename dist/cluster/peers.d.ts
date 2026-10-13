import type { SessionInfo } from '../adapters/types.js';
import type { Message } from '../mailbox/mailbox.js';
import type { DeviceIdentity } from './identity.js';
export interface Peer {
    device: string;
    host: string;
    /** The peer's mutual-TLS port (ADR-028). */
    port: number;
    /** Device ID from mDNS TXT — public, and only usable by whoever holds its key. */
    id: string;
    lastSeenAt: number;
}
/** What we present when calling a peer: our identity and our device name. */
export interface PeerClient {
    identity: DeviceIdentity;
    selfName: string;
}
export interface PeerRegistry {
    list(): Peer[];
    get(device: string): Peer | undefined;
    /** Manually add a peer (debugging / no-mDNS environments). */
    addStatic(device: string, host: string, port: number, id: string): void;
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
    /** Our mutual-TLS peer port, announced over mDNS. */
    port: number;
    /** Our public device ID, announced so others can pair with us (ADR-028). */
    selfId: string;
    /** Disable mDNS (tests / --peer only mode). */
    mdns?: boolean;
    /** Browse without announcing — for passive CLI scans that have no real port. */
    publish?: boolean;
}
/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export declare function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry;
type PeerAddress = Pick<Peer, 'device' | 'host' | 'port' | 'id'>;
/** Pull a peer's local session directory, stamping each entry with its device. */
export declare function fetchPeerSessions(peer: Peer, client: PeerClient): Promise<SessionInfo[]>;
/**
 * Push our copy of a collaboration doc (serialized markdown) to a peer daemon,
 * which merges it convergently (Phase 4 / M3).
 */
export declare function pushCollabDoc(peer: PeerAddress, docSerialized: string, client: PeerClient): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Hand a message to the peer daemon. Perspective flip: our 'to.device' becomes
 * the peer's local target. The peer records the sending device from OUR
 * certificate, not from this body (ADR-028).
 */
export declare function relayToPeer(peer: Peer, message: Message, client: PeerClient): Promise<{
    ok: boolean;
    error?: string;
}>;
export {};
