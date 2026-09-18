import { pickCandidate, type Box, type Direction } from "./spatial";

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled):not([type='checkbox']):not([type='radio']):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const FOCUS_SCOPE_ATTR = "data-focus-scope";

/**
 * Keys that mean "back" on TV remotes: Escape everywhere, plus the
 * vendor names/codes remotes emit (webOS 461, Tizen GoBack, Fire TV
 * 10009). Backspace counts only outside text fields.
 */
export function isBackKeyEvent(e: { key: string; keyCode: number }, targetIsText: boolean): boolean {
  if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack") return true;
  if (e.keyCode === 461 || e.keyCode === 10009) return true;
  if (e.key === "Backspace" && !targetIsText) return true;
  return false;
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset"].includes(type);
  }
  return false;
}

export function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Nearest enclosing focus scope (the details modal), or the document. */
export function scopeRootFor(el: HTMLElement | null): ParentNode {
  return el?.closest(`[${FOCUS_SCOPE_ATTR}]`) ?? document;
}

export function getFocusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    centerX: r.left + r.width / 2,
    centerY: r.top + r.height / 2
  };
}

/** Brings a focused element into view without jumpy page scrolling. */
export function reveal(el: HTMLElement): void {
  if (typeof el.scrollIntoView !== "function") return;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced ? "auto" : "smooth" });
}

/**
 * Moves focus one step in a direction within the current scope.
 * Focus lost to the body (e.g. a card unmounted) re-enters at the
 * first focusable. Returns whether focus moved.
 */
export function moveFocus(dir: Direction): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = scopeRootFor(active);
  const candidates = getFocusables(root)
    .map((el) => ({ el, box: boxOf(el) }))
    // Zero-area boxes are phantoms (unlaid-out or collapsed) and are
    // never valid spatial targets.
    .filter((i) => i.box.right > i.box.left && i.box.bottom > i.box.top);
  if (!candidates.length) return false;

  const activeEntry = active ? candidates.find((i) => i.el === active) : undefined;
  if (!activeEntry) {
    const first = candidates[0].el;
    first.focus({ preventScroll: true });
    reveal(first);
    return true;
  }

  const next = pickCandidate(
    activeEntry.box,
    candidates.map((i) => ({ box: i.box, value: i.el })),
    dir
  );
  if (!next) return false;
  next.focus({ preventScroll: true });
  reveal(next);
  return true;
}

/**
 * Wraps Tab inside a focus scope (modal). Outside a scope Tab follows
 * DOM order and the browser handles it. Returns whether Tab was handled.
 */
export function trapTab(e: { shiftKey: boolean }): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const scope = active?.closest<HTMLElement>(`[${FOCUS_SCOPE_ATTR}]`);
  if (!scope) return false;
  const items = getFocusables(scope);
  if (!items.length) return false;
  const index = active ? items.indexOf(active) : -1;
  if (index === -1) {
    items[0].focus();
    return true;
  }
  const delta = e.shiftKey ? -1 : 1;
  items[(index + delta + items.length) % items.length].focus();
  return true;
}

/** Focuses the first focusable inside a scope, e.g. a freshly opened modal. */
export function focusInitialIn(root: ParentNode): HTMLElement | null {
  const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
  const target = preferred && isVisible(preferred) ? preferred : (getFocusables(root)[0] ?? null);
  target?.focus({ preventScroll: true });
  return target;
}
