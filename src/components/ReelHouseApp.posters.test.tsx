/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReelHouseApp from "./ReelHouseApp";
import { POSTER_SIZES } from "@/lib/poster-image";
import type { LibraryPayload, MediaItem } from "@/lib/types";

function installDeferredFetch(): Array<{ url: string; resolve: (response: Response) => void }> {
  const calls: Array<{ url: string; resolve: (response: Response) => void }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      return new Promise<Response>((resolve) => {
        calls.push({ url: String(input), resolve });
      });
    })
  );
  return calls;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const JELLYFIN_POSTER = "https://jf.example/Items/p1/Images/Primary?maxWidth=600&quality=90&tag=t1";
const JELLYFIN_BACKDROP = "https://jf.example/Items/h1/Images/Backdrop?maxWidth=1600&quality=90&tag=t1";

function withImage(overrides: Partial<MediaItem>): MediaItem {
  return { id: "art-1", title: "Broken Art", kind: "Movie", ...overrides };
}

const LIBRARY: LibraryPayload = {
  source: "jellyfin",
  hero: { id: "h1", title: "Hero Title", kind: "Movie" },
  sections: [{ title: "Movies", items: [withImage({ imageUrl: JELLYFIN_POSTER })] }]
};

function resolveLibrary(payload: LibraryPayload) {
  const calls = installDeferredFetch();
  render(<ReelHouseApp />);
  const call = calls.find((entry) => entry.url.includes("/api/library"));
  if (!call) throw new Error("library fetch never issued");
  call.resolve(jsonResponse(payload));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReelHouseApp poster performance guards", () => {
  it("renders Jellyfin posters with an ascending responsive srcSet and slot sizes", async () => {
    resolveLibrary(LIBRARY);
    const img = await screen.findByRole("button", { name: "Open Broken Art" })
      .then((card) => card.querySelector("img.poster-img"));
    expect(img).toBeTruthy();
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(img!.getAttribute("decoding")).toBe("async");
    expect(img!.getAttribute("src")).toBe(JELLYFIN_POSTER);
    expect(img!.getAttribute("sizes")).toBe(POSTER_SIZES);

    const entries = img!.getAttribute("srcSet")!.split(", ");
    expect(entries).toHaveLength(5);
    const widths = entries.map((entry) => Number(entry.split(" ")[1]?.replace("w", "")));
    expect(widths).toEqual([240, 360, 480, 720, 960]);
    for (const entry of entries) {
      expect(entry.split(" ")[0]).toContain("/Items/p1/Images/Primary?");
      expect(entry.split(" ")[0]).toContain("quality=90");
    }
  });

  it("keeps fixed-size demo art on a plain lazy src without srcSet", async () => {
    const picsum = "https://picsum.photos/seed/demo/600/900";
    resolveLibrary({ ...LIBRARY, sections: [{ title: "Movies", items: [withImage({ imageUrl: picsum })] }] });
    const card = await screen.findByRole("button", { name: "Open Broken Art" });
    const img = card.querySelector("img.poster-img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe(picsum);
    expect(img!.getAttribute("srcSet")).toBeNull();
    expect(img!.getAttribute("sizes")).toBeNull();
    expect(img!.getAttribute("loading")).toBe("lazy");
  });

  it("keeps every rendered poster lazy and inside the aspect-ratio slot", async () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      withImage({ id: `art-${index}`, title: `Art ${index}`, imageUrl: JELLYFIN_POSTER.replace("p1", `p${index}`) })
    );
    resolveLibrary({
      ...LIBRARY,
      sections: [
        { title: "Movies", items: items.slice(0, 3) },
        { title: "Shows", items: items.slice(3) }
      ]
    });
    await screen.findByRole("button", { name: "Open Art 5" });
    const posters = Array.from(document.querySelectorAll("img.poster-img"));
    expect(posters).toHaveLength(6);
    for (const poster of posters) {
      expect(poster.getAttribute("loading")).toBe("lazy");
      expect(poster.closest(".poster")).toBeTruthy();
    }
  });

  it("still falls back to the title initial when a srcSet-backed poster fails", async () => {
    resolveLibrary(LIBRARY);
    const card = await screen.findByRole("button", { name: "Open Broken Art" });
    const img = card.querySelector("img.poster-img");
    expect(img!.getAttribute("srcSet")).not.toBeNull();
    fireEvent.error(img!);
    expect(card.querySelector("img.poster-img")).toBeNull();
    expect(card.textContent).toContain("B");
  });
});

describe("ReelHouseApp hero loading policy", () => {
  it("loads the hero backdrop eagerly at high priority sized to the viewport", async () => {
    resolveLibrary({ ...LIBRARY, hero: { id: "h1", title: "Hero Title", kind: "Movie", backdropUrl: JELLYFIN_BACKDROP } });
    await screen.findByText("Hero Title");
    const hero = document.querySelector("img.hero-bg");
    expect(hero).toBeTruthy();
    expect(hero!.getAttribute("fetchpriority")).toBe("high");
    expect(hero!.getAttribute("loading")).toBeNull();
    expect(hero!.getAttribute("decoding")).toBe("async");
    expect(hero!.getAttribute("sizes")).toBe("100vw");
    expect(hero!.getAttribute("srcSet")).toContain("maxWidth=1920");
    expect(hero!.getAttribute("srcSet")).toContain("maxWidth=640");
    expect(hero!.getAttribute("src")).toBe(JELLYFIN_BACKDROP);
  });

  it("renders fixed-size hero art without srcSet and the page without hero art when none exists", async () => {
    const picsum = "https://picsum.photos/seed/demo-backdrop/1600/900";
    resolveLibrary({ ...LIBRARY, hero: { id: "h1", title: "Hero Title", kind: "Movie", backdropUrl: picsum } });
    await screen.findByText("Hero Title");
    const hero = document.querySelector("img.hero-bg");
    expect(hero).toBeTruthy();
    expect(hero!.getAttribute("srcSet")).toBeNull();
    expect(hero!.getAttribute("src")).toBe(picsum);
  });

  it("omits the hero layer entirely when the payload has no backdrop", async () => {
    resolveLibrary(LIBRARY);
    await screen.findByText("Hero Title");
    expect(document.querySelector("img.hero-bg")).toBeNull();
    expect(screen.getByText("Hero Title")).toBeTruthy();
  });
});
