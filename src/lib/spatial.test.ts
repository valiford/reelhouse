import { describe, expect, it } from "vitest";
import { pickCandidate, type Box, type SpatialCandidate } from "./spatial";

function box(x: number, y: number, w = 100, h = 100): Box {
  return { left: x, top: y, right: x + w, bottom: y + h, centerX: x + w / 2, centerY: y + h / 2 };
}

function at(x: number, y: number, w = 100, h = 100): SpatialCandidate<string> {
  return { box: box(x, y, w, h), value: `${x},${y}` };
}

describe("pickCandidate", () => {
  it("picks the immediate neighbour in the direction of travel", () => {
    const next = pickCandidate(box(0, 0), [at(110, 0), at(230, 0), at(370, 0)], "right");
    expect(next).toBe("110,0");
  });

  it("returns null when nothing lies ahead so edges hold focus", () => {
    expect(pickCandidate(box(230, 0), [at(110, 0)], "right")).toBeNull();
    expect(pickCandidate(box(0, 0), [at(110, 0)], "left")).toBeNull();
    expect(pickCandidate(box(0, 0), [at(0, 400)], "up")).toBeNull();
    expect(pickCandidate(box(0, 400), [at(0, 0)], "down")).toBeNull();
  });

  it("prefers a candidate that overlaps on the cross axis", () => {
    const from = box(0, 100);
    const aligned = pickCandidate(from, [at(300, 0), at(150, 120)], "right");
    expect(aligned).toBe("150,120");
  });

  it("moves down to the aligned column of the next rail", () => {
    const from = box(220, 0, 200, 300);
    const row = [at(0, 350, 200, 300), at(220, 350, 200, 300), at(440, 350, 200, 300)];
    expect(pickCandidate(from, row, "down")).toBe("220,350");
  });

  it("moves up symmetrically", () => {
    const from = box(220, 350, 200, 300);
    const row = [at(0, 0, 200, 300), at(220, 0, 200, 300), at(440, 0, 200, 300)];
    expect(pickCandidate(from, row, "up")).toBe("220,0");
  });

  it("excludes siblings that share the primary axis", () => {
    const from = box(220, 0, 200, 300);
    const row = [at(0, 0, 200, 300), at(440, 0, 200, 300)];
    expect(pickCandidate(from, row, "down")).toBeNull();
    expect(pickCandidate(from, row, "up")).toBeNull();
  });

  it("tolerates a small edge kiss along the axis of travel", () => {
    const from = box(0, 0, 100, 100);
    expect(pickCandidate(from, [at(94, 0)], "right")).toBe("94,0");
    expect(pickCandidate(from, [at(80, 0)], "right")).toBeNull();
  });

  it("breaks ties by candidate order", () => {
    const from = box(0, 0, 800, 60);
    const cards = [at(0, 200, 200, 300), at(600, 200, 200, 300)];
    expect(pickCandidate(from, cards, "down")).toBe("0,200");
  });
});
