/**
 * Device identity, Syncthing-style (ADR-028): every device owns an Ed25519 key and
 * a self-signed certificate; its device ID is the SHA-256 of that certificate.
 * The ID is public — pairing exchanges IDs, never secrets — and only the holder of
 * the private key can present a certificate with that fingerprint.
 *
 * Node can make the key but not the certificate, so the (fixed-shape, extension-
 * free) DER is encoded here: zero dependencies, verified with X509Certificate.
 */
export interface DeviceIdentity {
    /** Formatted device ID, e.g. ABCDEFG-HIJKLMN-…-XYZ */
    id: string;
    certPem: string;
    keyPem: string;
}
/**
 * Positive INTEGER in canonical DER: no redundant leading 0x00 (strict parsers —
 * OpenSSL 3.0 / Node 20 — reject "illegal padding"), and a single 0x00 only when
 * the high bit would otherwise make it negative.
 */
export declare function derInteger(bytes: Buffer): Buffer;
/** A fresh key pair and a self-signed certificate for it. */
export declare function createSelfSignedIdentity(now?: Date): {
    certPem: string;
    keyPem: string;
};
/** Group a bare 52-char ID as XXXXXXX-XXXXXXX-…-XXX. */
export declare function formatDeviceId(bare: string): string;
/** The device ID a certificate (DER) stands for. */
export declare function deviceIdFromCert(der: Buffer): string;
/** Accept what a human pastes — any case, spaces, dashes. null = not a device ID. */
export declare function normalizeDeviceId(input: string): string | null;
export declare const shortDeviceId: (id: string) => string;
/** This device's identity, created on first use under ~/.anytoany/identity/. */
export declare function loadOrCreateIdentity(home?: string): DeviceIdentity;
