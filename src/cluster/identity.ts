import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anytoanyHome } from '../home.js';

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

const ED25519_OID = [1, 3, 101, 112];
const CN_OID = [2, 5, 4, 3];
const COMMON_NAME = 'anytoany';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_LENGTH = 52; // 256 bits / 5 bits per char, rounded up
const ID_GROUP = 7;

// --- minimal DER ------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

function oid(arcs: number[]): Buffer {
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      chunk.unshift((v % 128) | (chunk.length ? 0x80 : 0));
      if (v < 128) break;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** Positive INTEGER from raw bytes (prefix 0x00 when the high bit is set). */
const integer = (bytes: Buffer): Buffer => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);

const name = (cn: string): Buffer => seq(set(seq(oid(CN_OID), tlv(0x0c, Buffer.from(cn, 'utf8')))));

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/** RFC 5280 §4.1.2.5: 99991231235959Z means "no well-defined expiration". */
const NO_EXPIRY = tlv(0x18, Buffer.from('99991231235959Z', 'ascii'));

// --- identity ------------------------------------------------------------------

/** A fresh key pair and a self-signed certificate for it. */
export function createSelfSignedIdentity(now: Date = new Date()): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const algorithm = seq(oid(ED25519_OID));
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f; // keep it positive and 16 bytes
  // backdate a day so a peer with a slightly slow clock still accepts it
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] version v3
    integer(serial),
    algorithm,
    name(COMMON_NAME),
    seq(utcTime(notBefore), NO_EXPIRY),
    name(COMMON_NAME),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign(null, tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Group a bare 52-char ID as XXXXXXX-XXXXXXX-…-XXX. */
export function formatDeviceId(bare: string): string {
  return bare.match(new RegExp(`.{1,${ID_GROUP}}`, 'g'))?.join('-') ?? bare;
}

/** The device ID a certificate (DER) stands for. */
export function deviceIdFromCert(der: Buffer): string {
  return formatDeviceId(base32(createHash('sha256').update(der).digest()));
}

/** Accept what a human pastes — any case, spaces, dashes. null = not a device ID. */
export function normalizeDeviceId(input: string): string | null {
  const bare = input.toUpperCase().replace(/[\s-]/g, '');
  if (bare.length !== ID_LENGTH || ![...bare].every((c) => BASE32.includes(c))) return null;
  return formatDeviceId(bare);
}

export const shortDeviceId = (id: string): string => id.slice(0, ID_GROUP);

/** This device's identity, created on first use under ~/.anytoany/identity/. */
export function loadOrCreateIdentity(home: string = anytoanyHome()): DeviceIdentity {
  const dir = join(home, '.anytoany', 'identity');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const fresh = createSelfSignedIdentity();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir's mode is masked by umask
    writeFileSync(keyPath, fresh.keyPem, { mode: 0o600 });
    writeFileSync(certPath, fresh.certPem, { mode: 0o644 });
  }
  const certPem = readFileSync(certPath, 'utf8');
  const keyPem = readFileSync(keyPath, 'utf8');
  return { id: deviceIdFromCert(new X509Certificate(certPem).raw), certPem, keyPem };
}
