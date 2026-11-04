// SPDX-License-Identifier: AGPL-3.0-only
// Fractional base-36 keys, ordered bytewise. A key never ends in zero, so
// there is always room between different valid keys without renumbering peers.
const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
export function between(lower?: string, upper?: string): string {
  for (const key of [lower, upper])
    if (key !== undefined && !/^[0-9a-z]*[1-9a-z]$/.test(key))
      throw new Error("Invalid ordering key");
  if (upper !== undefined && lower !== undefined && lower >= upper)
    throw new Error("Ordering bounds must be increasing");
  let a = lower ?? "";
  let b: string | undefined = upper;
  let prefix = "";
  while (true) {
    const low = a.length ? digits.indexOf(a[0]) : 0;
    const high = b === undefined ? 36 : digits.indexOf(b[0]);
    if (low === high) {
      prefix += digits[low];
      a = a.slice(1);
      b = b?.slice(1);
      continue;
    }
    if (high - low > 1) return prefix + digits[Math.ceil((low + high) / 2)];
    if (b !== undefined && b.length > 1) return prefix + b[0];
    prefix += digits[low];
    a = a.slice(1);
    b = undefined;
  }
}
