// Hermetic unit tests for the TV spatial-navigation engine (RH-0035).
//
// The focus order IS the remote-control contract: these tests pin the
// deterministic answers for every arrow direction — including the edge
// semantics (rails stop at their ends, vertical moves snap to the nearest
// slot, ties break downward) — so the living-room UI cannot regress into
// nondeterministic or DOM-dependent focus behavior. All pure; runs in the
// hermetic `npm test` pass.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFocusMap,
  firstFocusable,
  firstInBand,
  moveFocus
} from "./navigation.ts";

function railGrid(): ReturnType<typeof buildFocusMap> {
  // Three bands: a 2-button top bar, an empty-slot-0 hero row (slot gap),
  // and two rails of 3 cards with different offsets.
  return buildFocusMap([
    { id: "nav-home", band: 0, slot: 0 },
    { id: "nav-search", band: 0, slot: 1 },
    { id: "hero-play", band: 1, slot: 1 },
    { id: "hero-info", band: 1, slot: 2 },
    { id: "r1-c1", band: 2, slot: 0 },
    { id: "r1-c2", band: 2, slot: 1 },
    { id: "r1-c3", band: 2, slot: 2 },
    { id: "r2-c1", band: 3, slot: 0 },
    { id: "r2-c2", band: 3, slot: 1 },
    { id: "r2-c3", band: 3, slot: 2 }
  ]);
}

test("buildFocusMap preserves registration order and drops duplicates", () => {
  const map = buildFocusMap([
    { id: "a", band: 1, slot: 0 },
    { id: "b", band: 0, slot: 0 },
    { id: "a", band: 5, slot: 5 }, // duplicate id: first registration wins
    { id: "c", band: 1, slot: 0 } // duplicate coordinate: dropped entirely —
    // an unreachable twin would strand focus if it ever held it
  ]);
  assert.deepEqual(map.order, ["a", "b"]);
  assert.deepEqual(map.byId.get("a"), { id: "a", band: 1, slot: 0 });
  assert.equal(map.byId.has("c"), false);
});

test("buildFocusMap orders sparse slots inside a band", () => {
  const map = buildFocusMap([
    { id: "late", band: 0, slot: 9 },
    { id: "early", band: 0, slot: 2 }
  ]);
  assert.deepEqual(map.bands.get(0), ["early", "late"]);
});

test("firstFocusable and firstInBand follow registration/slot order", () => {
  const map = railGrid();
  assert.equal(firstFocusable(map), "nav-home");
  assert.equal(firstInBand(map, 2), "r1-c1");
  assert.equal(firstInBand(map, 7), null);
});

test("null current resolves to the first focusable target", () => {
  const map = railGrid();
  assert.equal(moveFocus(map, null, "down"), "nav-home");
  assert.equal(moveFocus(map, null, "left"), "nav-home");
});

test("unknown current id yields null, never a guess", () => {
  const map = railGrid();
  assert.equal(moveFocus(map, "ghost", "down"), null);
  assert.equal(moveFocus(map, "ghost", "left"), null);
});

test("horizontal movement stops at band edges instead of wrapping", () => {
  const map = railGrid();
  assert.equal(moveFocus(map, "r1-c1", "left"), null);
  assert.equal(moveFocus(map, "r1-c3", "right"), null);
  assert.equal(moveFocus(map, "r1-c2", "left"), "r1-c1");
  assert.equal(moveFocus(map, "r1-c2", "right"), "r1-c3");
});

test("vertical movement lands on the nearest existing band and slot", () => {
  const map = railGrid();
  // From the nav row down into the hero band (whose slots start at 1).
  assert.equal(moveFocus(map, "nav-home", "down"), "hero-play");
  assert.equal(moveFocus(map, "nav-search", "down"), "hero-play");
  // From the hero band's second target up to the nav row's nearest slot.
  assert.equal(moveFocus(map, "hero-info", "up"), "nav-search");
  // Rails: down goes straight through to the matching column.
  assert.equal(moveFocus(map, "r1-c3", "down"), "r2-c3");
  assert.equal(moveFocus(map, "r2-c1", "up"), "r1-c1");
});

test("vertical movement past the top and bottom of the layout stops", () => {
  const map = railGrid();
  assert.equal(moveFocus(map, "nav-home", "up"), null);
  assert.equal(moveFocus(map, "r2-c2", "down"), null);
});

test("vertical ties break to the smaller slot, deterministically", () => {
  // Current slot sits exactly between two targets of the target band.
  const map = buildFocusMap([
    { id: "top", band: 0, slot: 5 },
    { id: "left-pick", band: 1, slot: 4 },
    { id: "right-pick", band: 1, slot: 6 }
  ]);
  assert.equal(moveFocus(map, "top", "down"), "left-pick");
  assert.equal(moveFocus(map, "right-pick", "up"), "top");
  // Repeating the query changes nothing.
  const once = moveFocus(map, "top", "down");
  const twice = moveFocus(map, "top", "down");
  assert.equal(once, twice);
});

test("movement skips empty bands without dying on them", () => {
  const map = buildFocusMap([
    { id: "a", band: 0, slot: 0 },
    { id: "b", band: 4, slot: 0 }
  ]);
  assert.equal(moveFocus(map, "a", "down"), "b");
  assert.equal(moveFocus(map, "b", "up"), "a");
});

test("empty maps are inert", () => {
  const map = buildFocusMap([]);
  assert.equal(firstFocusable(map), null);
  assert.equal(moveFocus(map, null, "down"), null);
});
