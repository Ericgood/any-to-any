/**
 * Who this device trusts (ADR-028). Syncthing-style: a list of device IDs added by
 * hand on both sides. Revoking one device = removing one entry — no shared secret
 * to rotate across the cluster.
 *
 * Tiers: only `owner` exists — the operator's own devices, whose messages carry the
 * operator's authority (ADR-016). A future `guest` tier (someone else's device)
 * would deliver data, never commands; it is deliberately not addable yet.
 */
export type TrustTier = 'owner';
export interface TrustedDevice {
    id: string;
    name: string;
    tier: TrustTier;
    addedAt: number;
}
export interface TrustStore {
    list(): TrustedDevice[];
    get(id: string): TrustedDevice | undefined;
    byName(name: string): TrustedDevice | undefined;
    /** Add (or rename) an owner-tier device. */
    add(device: {
        id: string;
        name: string;
    }): TrustedDevice;
    /** Remove by device ID or name. false = nothing matched. */
    remove(idOrName: string): boolean;
}
/** Re-reads the file when its mtime changes, so `anyd pair add` applies to a running daemon. */
export declare function createTrustStore(home?: string): TrustStore;
