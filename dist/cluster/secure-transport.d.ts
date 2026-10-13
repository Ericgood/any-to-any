import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type DeviceIdentity } from './identity.js';
import type { TrustedDevice, TrustStore } from './trust.js';
export interface UntrustedContact {
    id: string;
    claimedName?: string;
    address?: string;
    at: number;
}
export interface PeerServerOptions {
    identity: DeviceIdentity;
    trust: TrustStore;
    port: number;
    host?: string;
    handle: (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void>;
    /** A device with a valid certificate that isn't paired yet — surfaced as a pairing request. */
    onUntrusted?: (contact: UntrustedContact) => void;
}
export interface PeerServer {
    port: number;
    close(): void;
}
export declare function startPeerServer(opts: PeerServerOptions): Promise<PeerServer>;
/** Which device answers at this address? (static peers, pairing hints) */
export declare function probePeerId(opts: {
    host: string;
    port: number;
    identity: DeviceIdentity;
    timeoutMs?: number;
}): Promise<string>;
export interface PeerRequestOptions {
    host: string;
    port: number;
    /** The device we mean to talk to — anything else is dropped before sending. */
    expectedId: string;
    identity: DeviceIdentity;
    /** Our device name, shown to an unpaired peer as the pairing request's label. */
    selfName: string;
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    timeoutMs?: number;
}
/** One JSON request over pinned mutual TLS. */
export declare function peerRequest(opts: PeerRequestOptions): Promise<{
    status: number;
    body: unknown;
}>;
