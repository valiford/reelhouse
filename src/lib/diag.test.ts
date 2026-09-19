import { describe, expect, it } from "vitest";
import { boundedMessage } from "./diag";

describe("boundedMessage", () => {
  it("extracts Error messages and accepts plain strings", () => {
    expect(boundedMessage(new Error("search HTTP 503"))).toBe("search HTTP 503");
    expect(boundedMessage("fetch failed")).toBe("fetch failed");
  });

  it("redacts non-string non-error values to a fixed placeholder", () => {
    expect(boundedMessage(undefined)).toBe("unknown error");
    expect(boundedMessage({ token: "secret" })).toBe("unknown error");
  });

  it("collapses whitespace", () => {
    expect(boundedMessage("line one\n  line   two")).toBe("line one line two");
  });

  it("truncates to the bound with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = boundedMessage(long);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("honours a custom bound", () => {
    expect(boundedMessage("abcdefghij", 4)).toBe("abc…");
  });
});
