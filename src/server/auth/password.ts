/**
 * Password hashing with scrypt (node:crypto, no native dependency). Stored format:
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 * so the parameters can be raised later without invalidating existing hashes.
 */
import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
const maxmem = (n: number, r: number) => 128 * n * r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Constant-time comparison; false for malformed or missing hashes. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const match = stored?.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  const [n, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (n < 2 || n > 2 ** 20 || r < 1 || p < 1) return false;
  const salt = Buffer.from(match[4] ?? "", "base64");
  const expected = Buffer.from(match[5] ?? "", "base64");
  if (expected.length === 0) return false;
  const key = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: maxmem(n, r) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** A valid hash to verify against when the account does not exist, so timing does not reveal it. */
export const dummyPasswordHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));
