import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

// ── Constants ────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const SCRYPT_COST = 16384;  // N = 2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

// Format: $scrypt$N$r$p$salt$hash (all base64)

// ── hashPassword ─────────────────────────────────────────────────

export function hashPassword(plain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_BYTES);

    scrypt(
      plain,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        const encoded = [
          '$scrypt',
          SCRYPT_COST,
          SCRYPT_BLOCK_SIZE,
          SCRYPT_PARALLELIZATION,
          salt.toString('base64'),
          derivedKey.toString('base64'),
        ].join('$');
        resolve(encoded);
      },
    );
  });
}

// ── verifyPassword ───────────────────────────────────────────────

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = hash.split('$');
    // parts: ['', 'scrypt', N, r, p, salt, hash]
    if (parts.length !== 7 || parts[1] !== 'scrypt') {
      resolve(false);
      return;
    }

    const N = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    const salt = Buffer.from(parts[5]!, 'base64');
    const expected = Buffer.from(parts[6]!, 'base64');

    scrypt(plain, salt, expected.length, { N, r, p }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(timingSafeEqual(derivedKey, expected));
    });
  });
}
