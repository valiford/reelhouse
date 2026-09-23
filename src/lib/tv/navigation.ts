// Deterministic spatial navigation for the living-room (TV remote) UI.
//
// The TV layer never queries the DOM to decide where focus goes next: the
// component registers the currently visible focus targets as a flat set of
// (band, slot) coordinates — band = visual row from top, slot = position
// within that row — and this module answers every arrow key from that map.
// Keeping it pure makes the focus order hermetically testable and identical
// across renders, which is the whole contract a remote-control UI needs.
//
// Movement rules (deliberate, documented):
// - Left/right stay inside the current band and STOP at its edges. No
//   wrapping: on a remote, silently jumping from a rail's last card to its
//   first reads as losing your place.
// - Up/down pick the nearest band that has targets, then the slot closest
//   to the current one; a tie resolves to the smaller slot, so the answer
//   is always a single deterministic element.
// - Registration order (order[]) is the document order used for initial
//   focus and focus restore — it never participates in arrow movement.

export type Direction = "left" | "right" | "up" | "down";

export interface FocusSpot {
  id: string;
  band: number;
  slot: number;
}

export interface FocusMap {
  // band -> target ids ordered by slot
  readonly bands: ReadonlyMap<number, readonly string[]>;
  // registration order: the document/focus order of the current layout
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, FocusSpot>;
  // lowest and highest non-empty bands; the vertical scan walks exactly
  // this range — an unbounded downward scan would spin forever past the
  // last band (found by the hermetic suite, never by a live remote).
  readonly extent: { min: number; max: number };
}

export function buildFocusMap(spots: readonly FocusSpot[]): FocusMap {
  const bySlot = new Map<number, Map<number, string>>();
  const byId = new Map<string, FocusSpot>();
  const order: string[] = [];
  for (const spot of spots) {
    // First claim wins on every axis: a duplicate id or a duplicate
    // (band, slot) coordinate is ignored entirely — a registered target
    // that arrows could never reach (or two targets sharing a cell) would
    // strand focus.
    if (byId.has(spot.id)) continue;
    if (bySlot.get(spot.band)?.has(spot.slot)) continue;
    byId.set(spot.id, spot);
    order.push(spot.id);
    let row = bySlot.get(spot.band);
    if (!row) {
      row = new Map<number, string>();
      bySlot.set(spot.band, row);
    }
    row.set(spot.slot, spot.id);
  }
  const bands = new Map<number, string[]>();
  for (const [band, row] of bySlot) {
    bands.set(
      band,
      [...row.keys()].sort((a, b) => a - b).map((slot) => row.get(slot) as string)
    );
  }
  const bandNumbers = [...bands.keys()];
  const extent = bandNumbers.length
    ? { min: Math.min(...bandNumbers), max: Math.max(...bandNumbers) }
    : { min: 0, max: -1 };
  return { bands, order, byId, extent };
}

export function firstFocusable(map: FocusMap): string | null {
  return map.order[0] ?? null;
}

export function firstInBand(map: FocusMap, band: number): string | null {
  const row = map.bands.get(band);
  return row && row.length ? row[0] : null;
}

function nearestSlot(row: readonly string[], byId: ReadonlyMap<string, FocusSpot>, target: number): string {
  // row is slot-ordered; pick the entry whose slot is closest to target,
  // ties to the smaller slot. rows are never empty here (callers guard).
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of row) {
    const spot = byId.get(id);
    if (!spot) continue;
    const distance = Math.abs(spot.slot - target);
    if (distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best as string;
}

export function moveFocus(map: FocusMap, currentId: string | null, direction: Direction): string | null {
  if (currentId === null) return firstFocusable(map);
  const current = map.byId.get(currentId);
  if (!current) return null;

  if (direction === "left" || direction === "right") {
    const row = map.bands.get(current.band);
    if (!row) return null;
    const index = row.indexOf(currentId);
    if (index < 0) return null;
    const nextIndex = direction === "left" ? index - 1 : index + 1;
    // Edges stop: no horizontal wrap.
    return row[nextIndex] ?? null;
  }

  const step = direction === "up" ? -1 : 1;
  const limit = direction === "up" ? map.extent.min - 1 : map.extent.max;
  for (let band = current.band + step; direction === "up" ? band >= limit : band <= limit; band += step) {
    const row = map.bands.get(band);
    if (row && row.length) return nearestSlot(row, map.byId, current.slot);
  }
  return null;
}
