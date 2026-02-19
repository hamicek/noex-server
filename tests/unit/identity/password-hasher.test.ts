import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/identity/password-hasher.js';

describe('password-hasher', () => {
  it('hashes a password and produces a scrypt-formatted string', async () => {
    const hash = await hashPassword('secret123');

    expect(hash).toMatch(/^\$scrypt\$/);
    const parts = hash.split('$');
    // ['', 'scrypt', N, r, p, salt, hash]
    expect(parts).toHaveLength(7);
    expect(parts[1]).toBe('scrypt');
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    const ok = await verifyPassword('correct-horse-battery-staple', hash);

    expect(ok).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('myPassword');
    const ok = await verifyPassword('wrongPassword', hash);

    expect(ok).toBe(false);
  });

  it('produces different hashes for the same input (unique salt)', async () => {
    const hash1 = await hashPassword('sameInput');
    const hash2 = await hashPassword('sameInput');

    expect(hash1).not.toBe(hash2);

    // But both verify correctly
    expect(await verifyPassword('sameInput', hash1)).toBe(true);
    expect(await verifyPassword('sameInput', hash2)).toBe(true);
  });

  it('rejects a malformed hash', async () => {
    const ok = await verifyPassword('anything', 'not-a-valid-hash');

    expect(ok).toBe(false);
  });

  it('rejects an empty password against a valid hash', async () => {
    const hash = await hashPassword('notempty');
    const ok = await verifyPassword('', hash);

    expect(ok).toBe(false);
  });

  it('handles empty password hashing', async () => {
    const hash = await hashPassword('');
    expect(await verifyPassword('', hash)).toBe(true);
    expect(await verifyPassword('notempty', hash)).toBe(false);
  });
});
