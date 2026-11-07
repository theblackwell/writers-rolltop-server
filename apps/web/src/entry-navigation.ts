// SPDX-License-Identifier: AGPL-3.0-only
import type { Entry } from "./entries.tsx";
/** Flush first, then confirm the entry is still live, before a link selects it. */
export async function prepareEntryPlace(
  id: string,
  flush: () => Promise<boolean>,
  load: () => Promise<Entry[]>,
) {
  if (!(await flush()))
    throw new Error(
      "Save or resolve your unsaved changes (the open scene or Story Bible entry) before opening this entry.",
    );
  if (!(await load()).some((e) => e.id === id && !e.deletedAt))
    throw new Error(
      "This entry is no longer live here. Review Trash or check names again.",
    );
  return id;
}
