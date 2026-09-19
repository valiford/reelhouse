import { vi } from "vitest";

// jsdom has no layout engine. Tests that exercise spatial navigation
// stamp deterministic rects on elements via a data-rect attribute
// ("left,top,width,height"); everything else measures as empty.
function rect(raw: string | null): DOMRect {
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as DOMRect;
  const [x = 0, y = 0, w = 0, h = 0] = raw.split(",").map(Number);
  return {
    x, y, width: w, height: h,
    left: x, top: y, right: x + w, bottom: y + h,
    toJSON: () => ({})
  } as DOMRect;
}

// DOM-backed stubs only apply in jsdom; node-environment files skip them.
if (typeof Element !== "undefined") {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rect(this.getAttribute("data-rect"));
  } as typeof Element.prototype.getBoundingClientRect;

  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn();
  }
}
