import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from '../adapters/types.js';
import type { CollabStore } from '../collab/store.js';
import type { Mailbox } from '../mailbox/mailbox.js';
import type { TrustedDevice } from './trust.js';
/**
 * Routes a paired device may call (ADR-028). Reached only through the mutual-TLS
 * peer server, which has already pinned the caller to an entry in our trust list —
 * so `peer` here is authenticated, and its trusted name (not anything in the body)
 * is what we record as the sending device.
 */
export interface PeerApiOptions {
    selfDevice: string;
    selfId?: string;
    mailbox: Mailbox;
    collab?: CollabStore;
    /** Local-only directory (no peer aggregation) served to peers. */
    localDirectory: () => Promise<SessionInfo[]>;
    /** Tell the local console something changed. */
    onChange?: () => void;
}
export declare function createPeerApiHandler(opts: PeerApiOptions): (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void>;
