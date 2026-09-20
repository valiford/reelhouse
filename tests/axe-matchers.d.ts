// `vitest` re-exports its Assertion interface from @vitest/expect, so module
// augmentation must target @vitest/expect (augmenting "vitest" is a no-op).
// This wires jest-dom's TestingLibraryMatchers and jest-axe's
// toHaveNoViolations onto vitest's expect for typechecking.
/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors jest-dom's own generic defaults */
/* eslint-disable @typescript-eslint/no-empty-object-type -- re-export merge, same as jest-dom's own d.ts */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "@vitest/expect" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}

export {};
