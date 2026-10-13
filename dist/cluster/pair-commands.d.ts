import { type Peer } from './peers.js';
import type { UntrustedContact } from './secure-transport.js';
import { type TrustedDevice } from './trust.js';
/** What the running daemon reports at /api/peers. */
export interface PeersSnapshot {
    lan: boolean;
    self?: {
        device: string;
        id: string;
    } | null;
    peers: Array<Peer & {
        paired?: boolean;
        trustedName?: string;
    }>;
    pending?: UntrustedContact[];
}
/** Name for a newly trusted device: explicit > what it announced/claimed > device-<short id>. */
export declare function suggestName(id: string, snapshot: PeersSnapshot | null): string;
export declare function showSelf(): void;
export declare function showInvite(): void;
export declare function addTrusted(rawId: string, opts: {
    name?: string;
    port: number;
}): Promise<boolean>;
export declare function removeTrusted(idOrName: string): boolean;
export declare function formatTrustList(devices: TrustedDevice[]): string[];
export declare function listTrusted(): void;
/** `anyd peers` lines: discovered devices, their pairing state, and pending requests. */
export declare function formatPeers(snapshot: PeersSnapshot, selfId: string): string[];
export declare function showPeers(port: number): Promise<void>;
