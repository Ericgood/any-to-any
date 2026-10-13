import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSelfSignedIdentity,
  derInteger,
  deviceIdFromCert,
  formatDeviceId,
  loadOrCreateIdentity,
  normalizeDeviceId,
  shortDeviceId,
} from '../src/cluster/identity.js';

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'anyd-identity-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('self-signed Ed25519 certificate (hand-rolled DER)', () => {
  it('parses as X.509, is self-signed, and verifies with its own key', () => {
    const { certPem } = createSelfSignedIdentity();
    const cert = new X509Certificate(certPem);
    expect(cert.subject).toContain('CN=anytoany');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(9999);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
  });

  it('every identity is different (fresh key + random serial)', () => {
    const a = createSelfSignedIdentity();
    const b = createSelfSignedIdentity();
    expect(a.certPem).not.toBe(b.certPem);
    expect(a.keyPem).not.toBe(b.keyPem);
  });
});

describe('canonical DER INTEGER (CI caught a 1-in-128 "illegal padding" on Node 20)', () => {
  it('never emits a redundant leading zero, adds one only for a set high bit', () => {
    expect(derInteger(Buffer.from([0x00, 0x05]))).toEqual(Buffer.from([0x02, 0x01, 0x05]));
    expect(derInteger(Buffer.from([0x00, 0x00, 0x7f, 0x01]))).toEqual(Buffer.from([0x02, 0x02, 0x7f, 0x01]));
    expect(derInteger(Buffer.from([0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(derInteger(Buffer.from([0x00, 0x80]))).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
    expect(derInteger(Buffer.from([0x02]))).toEqual(Buffer.from([0x02, 0x01, 0x02]));
    expect(derInteger(Buffer.from([0x00]))).toEqual(Buffer.from([0x02, 0x01, 0x00]));
  });

  it('serials are always canonical across many certificates', () => {
    for (let i = 0; i < 400; i++) {
      const serial = new X509Certificate(createSelfSignedIdentity().certPem).serialNumber;
      expect(serial).toMatch(/^[0-9A-F]{32}$/); // 16 bytes, positive, no padding byte
      expect(serial.startsWith('00')).toBe(false);
    }
  });
});

describe('device ID', () => {
  it('is base32(sha256(cert DER)), 52 chars, grouped 7-by-7', () => {
    const { certPem } = createSelfSignedIdentity();
    const id = deviceIdFromCert(new X509Certificate(certPem).raw);
    expect(id).toMatch(/^([A-Z2-7]{7}-){7}[A-Z2-7]{3}$/);
    expect(shortDeviceId(id)).toBe(id.slice(0, 7));
  });

  it('normalizes what a human pastes (case, spaces, dashes) and rejects junk', () => {
    const { certPem } = createSelfSignedIdentity();
    const id = deviceIdFromCert(new X509Certificate(certPem).raw);
    const messy = ` ${id.toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeDeviceId(messy)).toBe(id);
    expect(formatDeviceId(id.replace(/-/g, ''))).toBe(id);
    expect(normalizeDeviceId('ABC')).toBeNull();
    expect(normalizeDeviceId(`${id.replace(/-/g, '').slice(0, 51)}1`)).toBeNull(); // '1' is not base32
  });
});

describe('loadOrCreateIdentity', () => {
  it('creates once, is stable across loads, and locks the private key down', () => {
    const home = freshHome();
    const a = loadOrCreateIdentity(home);
    const b = loadOrCreateIdentity(home);
    expect(b.id).toBe(a.id);
    expect(b.certPem).toBe(a.certPem);
    const dir = join(home, '.anytoany', 'identity');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'key.pem')).mode & 0o777).toBe(0o600);
  });

  it('two homes get two different devices', () => {
    expect(loadOrCreateIdentity(freshHome()).id).not.toBe(loadOrCreateIdentity(freshHome()).id);
  });
});
