export type Direction = "up" | "down" | "left" | "right";

export type Box = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

export type SpatialCandidate<T> = {
  box: Box;
  value: T;
};

/**
 * Overlap tolerated along the movement axis before a candidate stops
 * counting as "ahead" — keeps adjacent rails/columns from being misread
 * as sideways moves when their edges kiss.
 */
const AXIS_TOLERANCE = 8;

/** Penalty per pixel of cross-axis misalignment when windows don't overlap. */
const CROSS_WEIGHT = 2;

function gap(from: number, to: number): number {
  return Math.max(0, to - from);
}

function isAhead(from: Box, cand: Box, dir: Direction): boolean {
  switch (dir) {
    case "right":
      return cand.left >= from.right - AXIS_TOLERANCE && cand.centerX > from.centerX;
    case "left":
      return cand.right <= from.left + AXIS_TOLERANCE && cand.centerX < from.centerX;
    case "down":
      return cand.top >= from.bottom - AXIS_TOLERANCE && cand.centerY > from.centerY;
    case "up":
      return cand.bottom <= from.top + AXIS_TOLERANCE && cand.centerY < from.centerY;
  }
}

function crossOffset(from: Box, cand: Box, dir: Direction): number {
  if (dir === "left" || dir === "right") {
    const overlap = Math.min(from.bottom, cand.bottom) - Math.max(from.top, cand.top);
    if (overlap > 0) return 0;
    return Math.abs(cand.centerY - from.centerY);
  }
  const overlap = Math.min(from.right, cand.right) - Math.max(from.left, cand.left);
  if (overlap > 0) return 0;
  return Math.abs(cand.centerX - from.centerX);
}

function score(from: Box, cand: Box, dir: Direction): number {
  const primary =
    dir === "right" ? gap(from.right, cand.left)
    : dir === "left" ? gap(cand.right, from.left)
    : dir === "down" ? gap(from.bottom, cand.top)
    : gap(cand.bottom, from.top);
  return primary + crossOffset(from, cand, dir) * CROSS_WEIGHT;
}

/**
 * Picks the best candidate in a direction, or null when nothing lies
 * ahead (edges keep focus where it is). Ties resolve to the earliest
 * candidate in list order so selection is deterministic.
 */
export function pickCandidate<T>(
  from: Box,
  candidates: ReadonlyArray<SpatialCandidate<T>>,
  dir: Direction
): T | null {
  let best: { value: T; score: number } | null = null;
  for (const cand of candidates) {
    if (!isAhead(from, cand.box, dir)) continue;
    const value = score(from, cand.box, dir);
    if (!best || value < best.score) best = { value: cand.value, score: value };
  }
  return best ? best.value : null;
}
