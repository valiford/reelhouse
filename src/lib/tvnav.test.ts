import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusInitialIn, getFocusables, isBackKeyEvent, isTextInput, moveFocus, reveal, scopeRootFor, trapTab } from "./tvnav";

function button(label: string, rect?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (rect) b.setAttribute("data-rect", rect);
  document.body.appendChild(b);
  return b;
}

beforeEach(() => {
  document.body.innerHTML = "";
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("isBackKeyEvent", () => {
  it("treats Escape and vendor back keys as back", () => {
    expect(isBackKeyEvent({ key: "Escape", keyCode: 0 }, false)).toBe(true);
    expect(isBackKeyEvent({ key: "GoBack", keyCode: 0 }, false)).toBe(true);
    expect(isBackKeyEvent({ key: "Untitled", keyCode: 461 }, false)).toBe(true);
    expect(isBackKeyEvent({ key: "Untitled", keyCode: 10009 }, false)).toBe(true);
  });

  it("counts Backspace outside text fields only", () => {
    expect(isBackKeyEvent({ key: "Backspace", keyCode: 8 }, false)).toBe(true);
    expect(isBackKeyEvent({ key: "Backspace", keyCode: 8 }, true)).toBe(false);
  });

  it("ignores ordinary keys", () => {
    expect(isBackKeyEvent({ key: "a", keyCode: 65 }, false)).toBe(false);
  });
});

describe("isTextInput", () => {
  it("detects text entry targets", () => {
    const input = document.createElement("input");
    expect(isTextInput(input)).toBe(true);
    expect(isTextInput(document.createElement("textarea"))).toBe(true);

    const checkbox = document.createElement("input");
    checkbox.setAttribute("type", "checkbox");
    expect(isTextInput(checkbox)).toBe(false);

    expect(isTextInput(document.createElement("button"))).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});

describe("getFocusables", () => {
  it("keeps enabled actionable elements in DOM order", () => {
    button("one");
    const disabled = button("two");
    disabled.disabled = true;
    const hidden = button("three");
    hidden.style.display = "none";
    const skipped = document.createElement("div");
    skipped.setAttribute("tabindex", "-1");
    document.body.appendChild(skipped);
    button("four");

    const labels = getFocusables(document).map((el) => el.textContent);
    expect(labels).toEqual(["one", "four"]);
  });
});

describe("scopeRootFor", () => {
  it("resolves the nearest focus scope, else the document", () => {
    const modal = document.createElement("div");
    modal.setAttribute("data-focus-scope", "");
    const inner = document.createElement("button");
    modal.appendChild(inner);
    document.body.appendChild(modal);

    expect(scopeRootFor(inner)).toBe(modal);
    expect(scopeRootFor(button("outside"))).toBe(document);
    expect(scopeRootFor(null)).toBe(document);
  });
});

describe("trapTab", () => {
  it("wraps Tab inside a scope and leaves outside focus alone", () => {
    const modal = document.createElement("div");
    modal.setAttribute("data-focus-scope", "");
    document.body.appendChild(modal);
    const first = document.createElement("button");
    const second = document.createElement("button");
    modal.append(first, second);
    const outside = button("outside");

    second.focus();
    expect(trapTab({ shiftKey: false })).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(trapTab({ shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(second);

    outside.focus();
    expect(trapTab({ shiftKey: false })).toBe(false);
  });
});

describe("moveFocus", () => {
  it("re-enters at the first focusable when focus is lost", () => {
    button("alpha", "0,0,200,50");
    button("beta", "220,0,200,50");
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(moveFocus("right")).toBe(true);
    expect(document.activeElement).toBe(document.body.querySelector("button"));
  });

  it("steps spatially between stamped rects and holds at edges", () => {
    const one = button("one", "0,0,200,50");
    const two = button("two", "220,0,200,50");
    const below = button("below", "220,120,200,50");

    one.focus();
    moveFocus("right");
    expect(document.activeElement).toBe(two);

    moveFocus("down");
    expect(document.activeElement).toBe(below);

    expect(moveFocus("right")).toBe(false);
    expect(document.activeElement).toBe(below);
  });

  it("never targets zero-area phantoms", () => {
    const real = button("real", "0,0,200,50");
    button("phantom"); // no data-rect: measures 0x0 in jsdom
    real.focus();

    expect(moveFocus("right")).toBe(false);
    expect(document.activeElement).toBe(real);
  });
});

describe("reveal", () => {
  it("scrolls the element into view without page jumps", () => {
    const el = button("scrolled");
    const scrollIntoView = vi.fn();
    el.scrollIntoView = scrollIntoView;

    reveal(el);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "smooth" });
  });
});

describe("focusInitialIn", () => {
  it("prefers the data-autofocus element, else the first focusable", () => {
    const scope = document.createElement("div");
    scope.setAttribute("data-focus-scope", "");
    const first = button("first");
    const preferred = button("preferred");
    preferred.setAttribute("data-autofocus", "");
    scope.append(first, preferred);

    expect(focusInitialIn(scope)).toBe(preferred);

    preferred.removeAttribute("data-autofocus");
    expect(focusInitialIn(scope)).toBe(first);
  });

  it("returns null for an empty scope instead of throwing", () => {
    const empty = document.createElement("div");
    document.body.appendChild(empty);
    expect(focusInitialIn(empty)).toBeNull();
  });
});
