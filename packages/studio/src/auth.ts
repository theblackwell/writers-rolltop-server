// SPDX-License-Identifier: AGPL-3.0-only
import {
  randomBytes,
  scrypt as derive,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(derive);
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validPasswordHash(value: string) {
  return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value);
}
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Use a password between 12 and 1024 characters.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function verify(password: unknown, hash: string) {
  if (
    typeof password !== "string" ||
    password.length > 1024 ||
    !validPasswordHash(hash)
  )
    return false;
  const [, salt, expected] = hash.split("$");
  return timingSafeEqual(
    (await scrypt(password, salt, 64)) as Buffer,
    Buffer.from(expected, "hex"),
  );
}
