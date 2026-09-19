import { describe, expect, it } from "vitest";
import { uniqueById } from "./uniqueById";

describe("uniqueById", () => {
  it("drops later duplicates and keeps first-seen order", () => {
    const items = [
      { id: "a", title: "First A" },
      { id: "b", title: "B" },
      { id: "a", title: "Second A" },
      { id: "c", title: "C" },
      { id: "b", title: "Second B" }
    ];
    expect(uniqueById(items)).toEqual([
      { id: "a", title: "First A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" }
    ]);
  });

  it("handles empty input and duplicate-free input", () => {
    expect(uniqueById([])).toEqual([]);
    const single = [{ id: "x", title: "X" }];
    expect(uniqueById(single)).toEqual(single);
  });
});
