/**
 * Spec 0001 AC-4: the tenant connection string is encrypted at rest with
 * AES-256-GCM using a dedicated 32 byte key. Real Web Crypto, no mocks.
 *
 * Spec: docs/specs/0001-web-platform-foundation-control-plane.md (AC-4)
 */
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../lib/encryption';

function makeKey(bytes = 32, fill = 7): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes).fill(fill)));
}

const KEY = makeKey();
const CONN = 'postgres://user:s3cret@ep-example.neon.tech/neondb?sslmode=require';

describe('tenant connection string encryption', () => {
  it('round trips a connection string (AC-4)', async () => {
    const encrypted = await encrypt(CONN, KEY);
    expect(await decrypt(encrypted, KEY)).toBe(CONN);
  });

  it('does not leave the plaintext or any secret fragment in the stored value (AC-4)', async () => {
    const encrypted = await encrypt(CONN, KEY);
    expect(encrypted).not.toContain('s3cret');
    expect(encrypted).not.toContain('postgres');
    expect(atob(encrypted)).not.toContain('s3cret');
  });

  it('uses a fresh IV, so encrypting the same input twice differs', async () => {
    const a = await encrypt(CONN, KEY);
    const b = await encrypt(CONN, KEY);
    expect(a).not.toBe(b);
    expect(await decrypt(a, KEY)).toBe(await decrypt(b, KEY));
  });

  it('round trips empty and unicode text', async () => {
    expect(await decrypt(await encrypt('', KEY), KEY)).toBe('');
    const text = 'pässwörd-日本語-🔐';
    expect(await decrypt(await encrypt(text, KEY), KEY)).toBe(text);
  });

  it('refuses to decrypt with a different key', async () => {
    const encrypted = await encrypt(CONN, KEY);
    await expect(decrypt(encrypted, makeKey(32, 9))).rejects.toThrow();
  });

  it('detects tampering with the ciphertext (GCM auth tag)', async () => {
    const encrypted = await encrypt(CONN, KEY);
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(decrypt(tampered, KEY)).rejects.toThrow();
  });

  it.each([16, 24, 31, 33, 0])(
    'rejects a key that decodes to %i bytes instead of 32',
    async (len) => {
      await expect(encrypt(CONN, makeKey(len))).rejects.toThrow(/32 bytes/);
      await expect(decrypt('AAAA', makeKey(len))).rejects.toThrow(/32 bytes/);
    }
  );

  it('rejects a key that is not valid base64', async () => {
    await expect(encrypt(CONN, '%%%not-base64%%%')).rejects.toThrow();
  });
});
