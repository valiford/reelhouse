"use client";

import { useEffect } from "react";
import { isBackKeyEvent, isTextInput, moveFocus, trapTab } from "@/lib/tvnav";
import type { Direction } from "@/lib/spatial";

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right"
};

type TvNavigationOptions = {
  /** Back/Escape state machine; returns true when a layer closed. */
  onBack: () => boolean;
};

/**
 * TV remote shell: arrow keys drive spatial focus, Enter/Space activate
 * natively, Back-family keys close the topmost layer, and visible focus
 * is flagged on <html> so styles can show the ring only for keyboard use.
 */
export function useTvNavigation({ onBack }: TvNavigationOptions): void {
  useEffect(() => {
    const markKeyboard = () => document.documentElement.setAttribute("data-kbd-nav", "true");
    const unmarkKeyboard = () => document.documentElement.removeAttribute("data-kbd-nav");

    const onKeyDown = (e: KeyboardEvent) => {
      const text = isTextInput(e.target);
      const arrow = ARROWS[e.key];

      if (arrow && (!text || arrow === "up" || arrow === "down")) {
        // Arrows never scroll the page in the TV shell; left/right inside
        // text fields stay caret keys.
        e.preventDefault();
        moveFocus(arrow);
        markKeyboard();
        return;
      }

      if (e.key === "Tab") {
        markKeyboard();
        if (trapTab(e)) e.preventDefault();
        return;
      }

      if (isBackKeyEvent(e, text) && onBack()) {
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", unmarkKeyboard);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", unmarkKeyboard);
    };
  }, [onBack]);
}
