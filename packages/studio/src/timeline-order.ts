// SPDX-License-Identifier: AGPL-3.0-only
export type TimelineEvent = {
  id: string;
  orderKey: string;
  when?: { ordinal?: number };
  sceneIds: string[];
};
/** Matches native timeline ordering. Only current-book live nodes have positions. */
export function orderedEvents<T extends TimelineEvent>(
  events: T[],
  positions: Record<string, number>,
  byReading: boolean,
): T[] {
  const position = (e: T): number | undefined => {
    if (!byReading) return e.when?.ordinal;
    let earliest: number | undefined;
    for (const id of e.sceneIds) {
      const p = positions[id];
      if (p !== undefined && (earliest === undefined || p < earliest))
        earliest = p;
    }
    return earliest;
  };
  return [...events].sort((a, b) => {
    const x = position(a),
      y = position(b);
    if (x === undefined && y !== undefined) return 1;
    if (y === undefined && x !== undefined) return -1;
    if (x !== undefined && y !== undefined && x !== y) return x < y ? -1 : 1;
    return a.orderKey < b.orderKey
      ? -1
      : a.orderKey > b.orderKey
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
}
