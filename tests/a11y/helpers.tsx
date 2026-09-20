import { render } from "@testing-library/react";
import { vi } from "vitest";
import ReelHouseApp from "@/components/ReelHouseApp";
import { demoLibrary } from "@/lib/demo";
import type { MediaItem } from "@/lib/types";

/**
 * Fetch doubles for the app's two client calls (/api/library, /api/search).
 * The component only consumes `.json()`, so a minimal response-like object
 * keeps these tests independent of any global fetch/Response polyfill.
 */
export type FetchStub = { ok: true; status: 200; json: () => Promise<unknown> };

export const jsonOk = (body: unknown): Promise<FetchStub> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** HTTP 200 with a body that fails `.json()` — simulates a proxy/HTML error page. */
export const jsonInvalid = (): Promise<FetchStub> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("Unexpected token < in JSON")) });

/** The request itself fails (network down, server unreachable). */
export const networkFail = (): Promise<FetchStub> => Promise.reject(new Error("network unreachable"));

export function defaultHandler(url: string): Promise<FetchStub> {
  if (url.includes("/api/library")) return jsonOk(demoLibrary);
  if (url.includes("/api/search")) return jsonOk({ items: [] });
  return networkFail();
}

export function searchHandler(items: MediaItem[]) {
  return (url: string): Promise<FetchStub> =>
    url.includes("/api/search") ? jsonOk({ items }) : defaultHandler(url);
}

export const demoItems: MediaItem[] = demoLibrary.sections.flatMap((section) => section.items)
  .filter((item, index, all) => all.findIndex((x) => x.id === item.id) === index);

export function renderApp(handler: (url: string) => Promise<FetchStub> = defaultHandler) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<ReelHouseApp />);
  return { ...view, fetchMock };
}
