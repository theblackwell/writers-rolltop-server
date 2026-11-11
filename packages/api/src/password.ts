// Password hashing with Node's built-in scrypt (no dependency). The stored string carries a version tag and its own
// cost parameters, so the cost can be raised later and old hashes still verify:
//   scrypt$v1$N=131072,r=8,p=1$<salt, base64>$<key, base64>
// Nothing here logs. Callers must never put a password or a hash in a log line or an error message.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Current cost: N=2^17, r=8, p=1 (about 128 MiB of memory per hash), 16-byte salt, 64-byte key. */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, saltBytes: 16, keyBytes: 64 } as const;

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_BYTES = 1024;

interface Params { N: number; r: number; p: number }

const derive = (password: string, salt: Buffer, keyBytes: number, { N, r, p }: Params): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxmem is a ceiling, not an allocation: scrypt needs about 128*N*r bytes, so allow twice that.
    scrypt(password, salt, keyBytes, { N, r, p, maxmem: 256 * N * r }, (e, key) => (e ? reject(e) : resolve(key)));
  });

/** NFKC-normalised, so the same typed password matches however a client composes its characters. */
export const normalizePassword = (password: string): string => password.normalize("NFKC");

/** Why a new password is not acceptable, or undefined if it is. No composition rules: length only. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string") return "The password must be text.";
  const p = normalizePassword(password);
  if (Buffer.byteLength(p, "utf8") > PASSWORD_MAX_BYTES) return `The password must be at most ${PASSWORD_MAX_BYTES} bytes.`;
  if ([...p].length < PASSWORD_MIN_CHARS || p.trim() === "") return `The password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  return undefined;
}

export async function hashPassword(password: string, params: Params & { saltBytes?: number; keyBytes?: number } = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(params.saltBytes ?? SCRYPT_PARAMS.saltBytes);
  const key = await derive(normalizePassword(password), salt, params.keyBytes ?? SCRYPT_PARAMS.keyBytes, params);
  return `scrypt$v1$N=${params.N},r=${params.r},p=${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

const FORMAT = /^scrypt\$v1\$N=(\d{1,8}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

/** Constant-time check. A malformed or out-of-range stored string is simply "no match". */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = FORMAT.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bounds are one step above the current cost (N=2^17, r=8, p=1): a stored string cannot make this server allocate more.
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 10 || N > 2 ** 18 || r < 1 || r > 8 || p !== 1) return false;
  const salt = Buffer.from(m[4]!, "base64"), expected = Buffer.from(m[5]!, "base64");
  if (salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
  const actual = await derive(normalizePassword(password), salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}
