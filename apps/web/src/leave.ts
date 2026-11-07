// SPDX-License-Identifier: AGPL-3.0-only
/** Run each flush in turn. The first failure stops the move, so nothing that
 * could not be saved is left behind. */
export async function flushAll(
  ...flushes: (null | undefined | (() => Promise<boolean>))[]
) {
  for (const flush of flushes) if (flush && !(await flush())) return false;
  return true;
}
