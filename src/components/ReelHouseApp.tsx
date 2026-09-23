"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaItem } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import { buildFocusMap, firstFocusable, moveFocus, type Direction, type FocusSpot } from "@/lib/tv/navigation";
import {
  cardFromCatalog,
  detailView,
  heroCard,
  statusBanner,
  visibleRails,
  type CatalogStatusPayload,
  type HomeFeedPayload,
  type ItemDetailPayload,
  type JellyfinHealthPayload,
  type UiCard,
  type UiRail
} from "@/lib/tv/viewmodel";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon } from "./icons";

// The living-room UI consumes the PostgreSQL read models (RH-0034) through
// their HTTP surface and never touches the database itself: /api/home for the
// profile's rails, /api/catalog/search for discovery, /api/catalog/items/:id
// for detail facets, /api/catalog/status + /api/health for the degraded-state
// banners. When /api/health reports the database unconfigured, the UI falls
// back to the documented demo mode (demo library + /api/search) so a fresh
// checkout still demonstrates the full remote-control interaction layer.
// Playback remains a Jellyfin deep link — ReelHouse never streams.

type Boot =
  | { phase: "boot" }
  | { phase: "demo" }
  | { phase: "loading" }
  | { phase: "ready"; feed: HomeFeedPayload }
  | { phase: "error"; detail: string; kind: "database" | "profile" };

type Mode = "home" | "search";

interface SearchFilters {
  q: string;
  types: string[]; // catalog item types in PG mode, MediaItem kinds in demo mode
  library: string | null;
}

type Detail =
  | { phase: "loading"; card: UiCard }
  | { phase: "ready"; card: UiCard; view: ReturnType<typeof detailView> }
  | { phase: "missing"; card: UiCard }
  | { phase: "error"; card: UiCard; detail: string };

type SearchState = "idle" | "loading" | "ready" | "empty" | "error";

// The search view holds display-ready cards, not raw read-model rows: both
// the PG path (/api/catalog/search → cardFromCatalog) and the demo path
// (/api/search → cardFromDemo) land in this one shape.
interface SearchResults {
  cards: UiCard[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const SEARCH_PAGE_SIZE = 24;

// The catalog normalizes Jellyfin "Video" items to "movie", so the type axis
// cannot express a "Home Videos" slice; home-video libraries surface through
// their library rails and the libraries= search filter instead.
const NAV_PRESETS: Array<{ id: string; label: string; pg: string[]; demo: string[] }> = [
  { id: "home", label: "Home", pg: [], demo: [] },
  { id: "movies", label: "Movies", pg: ["movie"], demo: ["Movie"] },
  { id: "shows", label: "Shows", pg: ["series"], demo: ["Series"] }
];

function cardFromDemo(item: MediaItem, keyPrefix: string): UiCard {
  return {
    key: `${keyPrefix}:${item.id}`,
    jellyfinId: item.id,
    libraryJellyfinId: "demo",
    title: item.title,
    subtitle: null,
    year: item.year ?? null,
    kindLabel: item.kind,
    rating: item.rating ?? null,
    progress: typeof item.progress === "number" ? Math.min(100, Math.round(item.progress)) : null,
    imageUrl: item.imageUrl ?? null,
    backdropUrl: item.backdropUrl ?? null,
    playHref: null
  };
}

function demoRails(): UiRail[] {
  return demoLibrary.sections.map((section) => ({
    slug: `demo-${section.title.toLowerCase().replace(/\s+/g, "-")}`,
    kind: "library",
    title: section.title,
    cards: section.items.map((item) => cardFromDemo(item, "demo"))
  }));
}

function demoHero(): UiCard {
  return cardFromDemo(demoLibrary.hero, "demo-hero");
}

function publicJellyfinUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_JELLYFIN_URL?.trim().replace(/\/+$/, "");
  return url || null;
}

// Demo items have no catalog rows behind them, so their modal renders from
// the card itself — the same UiDetail shape the /api/catalog/items mapper
// produces, so the modal markup never branches on data source.
function detailFromCard(card: UiCard): ReturnType<typeof detailView> {
  return {
    jellyfinId: card.jellyfinId,
    title: card.title,
    kindLabel: card.kindLabel,
    year: card.year,
    rating: card.rating,
    officialRating: null,
    overview: card.subtitle,
    libraryName: "",
    genres: [],
    studios: [],
    people: [],
    providerNames: [],
    playHref: card.playHref,
    backdropUrl: card.backdropUrl,
    fileSummary: null
  };
}

// Fixed result-grid columns per density tier, mirrored exactly by the CSS
// grid-template-columns breakpoints, so the engine's band math always equals
// the visual rows.
const COLUMN_QUERIES: Array<[string, number]> = [
  ["(min-width: 2400px)", 6],
  ["(min-width: 1600px)", 5],
  ["(min-width: 1100px)", 4]
];

function useColumns(): number {
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const queries = COLUMN_QUERIES.map(([query, count]) => ({ mq: window.matchMedia(query), count }));
    const compute = () => setColumns(queries.find(({ mq }) => mq.matches)?.count ?? 3);
    compute();
    for (const { mq } of queries) mq.addEventListener("change", compute);
    return () => {
      for (const { mq } of queries) mq.removeEventListener("change", compute);
    };
  }, []);
  return columns;
}

function Card({
  card,
  focusId,
  isFocused,
  onCardFocus,
  onOpen
}: {
  card: UiCard;
  focusId: string;
  isFocused: boolean;
  onCardFocus: (id: string) => void;
  onOpen: (card: UiCard, opener: string) => void;
}) {
  return (
      <button
        className="media-card"
        data-focus-id={focusId}
        tabIndex={isFocused ? 0 : -1}
        aria-label={`Open ${card.title}${card.progress !== null ? `, ${card.progress}% watched` : ""}`}
        onFocus={() => onCardFocus(focusId)}
        onClick={() => onOpen(card, focusId)}
      >
      <div className="poster" style={card.imageUrl ? { backgroundImage: `url(${card.imageUrl})` } : undefined}>
        {!card.imageUrl && <span aria-hidden>{card.title.slice(0, 1)}</span>}
        <div className="card-gradient" />
        <div className="card-copy">
          <strong>{card.title}</strong>
          <small>{card.subtitle || card.year || card.kindLabel}</small>
        </div>
        {card.progress !== null && (
          <div className="progress">
            <span style={{ width: `${card.progress}%` }} />
          </div>
        )}
      </div>
    </button>
  );
}

export default function ReelHouseApp() {
  const [profileSlug] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("profile")
  );
  const [boot, setBoot] = useState<Boot>({ phase: "boot" });
  const [status, setStatus] = useState<CatalogStatusPayload | null>(null);
  const [jellyfin, setJellyfin] = useState<JellyfinHealthPayload | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [mode, setMode] = useState<Mode>("home");
  const [filters, setFilters] = useState<SearchFilters>({ q: "", types: [], library: null });
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchTick, setSearchTick] = useState(0);

  const [detail, setDetail] = useState<Detail | null>(null);
  const openerRef = useRef<string | null>(null);

  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const columns = useColumns();

  const publicUrl = useMemo(() => publicJellyfinUrl(), []);

  const homeUrl = useMemo(
    () => `/api/home${profileSlug ? `?profile=${encodeURIComponent(profileSlug)}` : ""}`,
    [profileSlug]
  );

  // Boot: health routes the UI between demo mode and the PG-backed feed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBoot({ phase: "boot" });
      setStatus(null);
      try {
        const healthRes = await fetch("/api/health");
        const health = await healthRes.json();
        if (cancelled) return;
        setJellyfin(health?.jellyfin ?? null);
        if (health?.database?.state === "unconfigured") {
          setBoot({ phase: "demo" });
          setFocusId("hero-play");
          return;
        }
        setBoot({ phase: "loading" });
        const [homeRes, statusRes] = await Promise.all([
          fetch(homeUrl),
          fetch("/api/catalog/status").catch(() => null)
        ]);
        if (cancelled) return;
        if (statusRes?.ok) setStatus(await statusRes.json());
        const body = await homeRes.json().catch(() => null);
        if (homeRes.status === 404) {
          setBoot({ phase: "error", kind: "profile", detail: body?.detail || "profile not found" });
          return;
        }
        if (!homeRes.ok) {
          setBoot({ phase: "error", kind: "database", detail: body?.detail || `HTTP ${homeRes.status}` });
          return;
        }
        setBoot({ phase: "ready", feed: body });
        // Initial focus lands on the hero Play control; the roving-focus
        // effect no-ops safely when an empty feed renders no such spot.
        setFocusId("hero-play");
      } catch {
        if (!cancelled) setBoot({ phase: "error", kind: "database", detail: "ReelHouse could not reach the server." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [homeUrl, retryTick]);

  // Feed-derived view models.
  const rails = useMemo<UiRail[]>(
    () => (boot.phase === "ready" ? visibleRails(boot.feed, publicUrl) : boot.phase === "demo" ? demoRails() : []),
    [boot, publicUrl]
  );
  const hero = useMemo<UiCard | null>(
    () => (boot.phase === "ready" ? heroCard(boot.feed, publicUrl) : boot.phase === "demo" ? demoHero() : null),
    [boot, publicUrl]
  );

  // Derived, not stored: the resolved profile pill follows the feed.
  const activeProfile = useMemo(
    () =>
      boot.phase === "ready" && boot.feed.profile
        ? { display_name: boot.feed.profile.display_name, initials: boot.feed.profile.initials }
        : null,
    [boot]
  );

  const unresolvedCount = useMemo(
    () => (boot.phase === "ready" ? boot.feed.rows.filter((row) => row.enabled && !row.resolved).length : 0),
    [boot]
  );
  const banner = useMemo(
    () => (boot.phase === "ready" ? statusBanner(status, jellyfin) : null),
    [boot, status, jellyfin]
  );

  // Search effect: debounced, bounded, mode-aware (PG read models in ready
  // mode, the demo route in demo mode). Both paths land in SearchResults.
  useEffect(() => {
    if (mode !== "search" || (boot.phase !== "ready" && boot.phase !== "demo")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchState("loading");
      try {
        if (boot.phase === "demo") {
          const q = filters.q.trim();
          if (!q && !filters.types.length) {
            setResults(null);
            setSearchState("idle");
            return;
          }
          const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
          const body = await res.json();
          let items: MediaItem[] = body.items || [];
          if (filters.types.length) items = items.filter((item) => filters.types.includes(item.kind));
          const seen = new Set<string>();
          const cards = items
            .filter((item) => (seen.has(item.id) ? false : !!seen.add(item.id)))
            .map((item) => cardFromDemo(item, "demo-search"));
          setResults({ cards, total: cards.length, limit: cards.length, offset: 0, hasMore: false });
          setSearchState(cards.length ? "ready" : "empty");
          return;
        }
        const params = new URLSearchParams();
        if (filters.q.trim()) params.set("q", filters.q.trim());
        for (const type of filters.types) params.append("types", type);
        if (filters.library) params.set("libraries", filters.library);
        params.set("limit", String(SEARCH_PAGE_SIZE));
        const res = await fetch(`/api/catalog/search?${params.toString()}`, { signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
        const page = body.page as { items: Parameters<typeof cardFromCatalog>[0][]; total: number; limit: number; offset: number; hasMore: boolean };
        const cards = page.items.map((row) => cardFromCatalog(row, "search", publicUrl));
        setResults({ cards, total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore });
        setSearchState(cards.length ? "ready" : "empty");
      } catch {
        if (!controller.signal.aborted) setSearchState("error");
      }
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [mode, boot.phase, filters, searchTick, publicUrl]);

  async function loadMore() {
    if (boot.phase !== "ready" || !results?.hasMore) return;
    const offset = results.offset + results.limit;
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set("q", filters.q.trim());
    for (const type of filters.types) params.append("types", type);
    if (filters.library) params.set("libraries", filters.library);
    params.set("limit", String(SEARCH_PAGE_SIZE));
    params.set("offset", String(offset));
    try {
      const res = await fetch(`/api/catalog/search?${params.toString()}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
      const page = body.page as { items: Parameters<typeof cardFromCatalog>[0][]; total: number; limit: number; offset: number; hasMore: boolean };
      const cards = page.items.map((row) => cardFromCatalog(row, "search", publicUrl));
      setResults({
        cards: [...results.cards, ...cards],
        total: page.total,
        limit: page.limit,
        offset,
        hasMore: page.hasMore
      });
      setSearchState("ready");
    } catch {
      setSearchState("error");
    }
  }

  // Detail modal over /api/catalog/items/:id (demo cards resolve locally).
  const openDetail = useCallback(
    (card: UiCard, opener: string) => {
      openerRef.current = opener;
      setFocusId("modal-close");
      if (boot.phase === "demo" || card.jellyfinId.startsWith("demo-")) {
        setDetail({ phase: "ready", card, view: detailFromCard(card) });
        return;
      }
      setDetail({ phase: "loading", card });
      (async () => {
        try {
          const res = await fetch(`/api/catalog/items/${encodeURIComponent(card.jellyfinId)}`);
          const raw = (await res.json().catch(() => null)) as { detail?: string } | ItemDetailPayload | null;
          const errorDetail = raw && "detail" in raw && typeof raw.detail === "string" ? raw.detail : null;
          if (!res.ok) {
            setDetail(
              res.status === 404
                ? { phase: "missing", card }
                : { phase: "error", card, detail: errorDetail || `HTTP ${res.status}` }
            );
            return;
          }
          setDetail({ phase: "ready", card, view: detailView(raw as ItemDetailPayload, publicUrl) });
        } catch {
          setDetail({ phase: "error", card, detail: "ReelHouse could not reach the server." });
        }
      })();
    },
    [boot.phase, publicUrl]
  );

  const closeDetail = useCallback(() => {
    setDetail(null);
    setFocusId(openerRef.current ?? "nav-home");
    openerRef.current = null;
  }, []);

  const openSearch = useCallback((next: SearchFilters) => {
    setFilters(next);
    setResults(null);
    setSearchState("idle");
    setMode("search");
    setFocusId("search-input");
  }, []);

  const goHome = useCallback(() => {
    setMode("home");
    setFocusId(hero ? "hero-play" : rails.length ? `${rails[0].slug}:card:0` : "nav-home");
  }, [hero, rails]);

  const closeSearch = useCallback(() => {
    setMode("home");
    setFocusId("nav-search");
  }, []);

  // Focus registration: one flat spot set per layout, rebuilt when the
  // layout changes. Bands mirror the visual rows exactly (top bar, hero,
  // rail heading + cards, search grid rows, modal actions).
  const spots = useMemo<FocusSpot[]>(() => {
    if (detail) {
      const modalSpots: FocusSpot[] = [{ id: "modal-close", band: 0, slot: 0 }];
      if (detail.phase === "ready" && detail.view.playHref) modalSpots.push({ id: "modal-play", band: 0, slot: 1 });
      if (detail.phase === "error") modalSpots.push({ id: "modal-retry", band: 0, slot: 1 });
      return modalSpots;
    }
    const navSpots: FocusSpot[] = NAV_PRESETS.map((preset, index) => ({ id: `nav-${preset.id}`, band: 0, slot: index }));
    navSpots.push({ id: "nav-search", band: 0, slot: NAV_PRESETS.length });
    if (mode === "search") {
      const searchSpots: FocusSpot[] = [...navSpots, { id: "search-input", band: 1, slot: 0 }];
      if (filters.library || filters.types.length) searchSpots.push({ id: "filter-clear", band: 1, slot: 1 });
      if (results) {
        results.cards.forEach((_, index) => {
          searchSpots.push({
            id: `result:${index}`,
            band: 2 + Math.floor(index / columns),
            slot: index % columns
          });
        });
        if (results.hasMore) {
          searchSpots.push({ id: "load-more", band: 2 + Math.ceil(results.cards.length / columns), slot: 0 });
        }
      }
      // A failed search with nothing on screen registers its retry button;
      // with results still shown, the retry panel is not rendered.
      if (searchState === "error" && !results) searchSpots.push({ id: "search-retry", band: 2, slot: 0 });
      return searchSpots;
    }
    const homeSpots: FocusSpot[] = [...navSpots];
    if (boot.phase === "ready" || boot.phase === "demo") {
      let band = 1;
      if (hero) {
        // The Play control is rendered (and focusable) in both modes: a
        // Jellyfin deep link when configured, a detail-opening demo button
        // otherwise.
        homeSpots.push({ id: "hero-play", band, slot: 0 }, { id: "hero-info", band, slot: 1 });
        band += 1;
      }
      for (const rail of rails) {
        homeSpots.push({ id: `${rail.slug}:seeall`, band, slot: 0 });
        band += 1;
        rail.cards.forEach((_, index) => homeSpots.push({ id: `${rail.slug}:card:${index}`, band, slot: index }));
        band += 1;
      }
    }
    if (boot.phase === "error") homeSpots.push({ id: "boot-retry", band: 1, slot: 0 });
    return homeSpots;
  }, [detail, mode, filters.library, filters.types, results, searchState, columns, boot, hero, rails]);

  const focusMap = useMemo(() => buildFocusMap(spots), [spots]);

  // Roving focus: exactly one tabbable target; focus and scroll follow the
  // engine's decisions, pointer focus stays in sync through onFocus.
  useEffect(() => {
    if (!focusId) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusId, spots]);

  const setFocus = useCallback((id: string | null) => {
    setFocusId(id);
  }, []);

  // The single keyboard entry point: arrows move focus through the engine,
  // Enter activates the real button/link natively, Back/Escape unwind layers
  // (modal → search → home) and restore focus deterministically.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inInput =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const arrow = /^Arrow(Left|Right|Up|Down)$/.test(event.key)
        ? (event.key.replace("Arrow", "").toLowerCase() as Direction)
        : null;

      if (detail) {
        if (event.key === "Escape" || event.key === "Backspace") {
          event.preventDefault();
          closeDetail();
          return;
        }
        if (event.key === "Tab") {
          // Focus trap: the modal is the whole world while it is open.
          event.preventDefault();
          const current = focusId && focusMap.byId.has(focusId) ? focusId : firstFocusable(focusMap);
          const next = event.shiftKey
            ? moveFocus(focusMap, current, "left") ?? focusMap.order[focusMap.order.length - 1]
            : moveFocus(focusMap, current, "right") ?? focusMap.order[0];
          if (next) setFocus(next);
          return;
        }
        if (arrow && !inInput) {
          event.preventDefault();
          const next = moveFocus(focusMap, focusId, arrow);
          if (next) setFocus(next);
        }
        return;
      }

      // While the search input owns the keyboard, text editing wins: no
      // arrow roving except ArrowDown into the results, and Escape/Backspace
      // leave search entirely.
      if (mode === "search" && inInput) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          const first = focusMap.bands.get(2)?.[0] ?? null;
          if (first) setFocus(first);
          return;
        }
        if (event.key === "Escape" || event.key === "Backspace") {
          event.preventDefault();
          closeSearch();
          return;
        }
        return;
      }

      if (arrow) {
        event.preventDefault();
        const current = focusId && focusMap.byId.has(focusId) ? focusId : firstFocusable(focusMap);
        const next = moveFocus(focusMap, current, arrow);
        if (next) setFocus(next);
        return;
      }
      if (event.key === "Escape" || event.key === "Backspace") {
        event.preventDefault();
        if (mode === "search") closeSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMap, focusId, detail, mode, closeDetail, closeSearch, setFocus]);

  const statusMessage = (() => {
    if (boot.phase === "boot" || boot.phase === "loading") return "Loading your ReelHouse feed";
    if (boot.phase === "error") {
      return boot.kind === "profile"
        ? `Profile unavailable: ${boot.detail}`
        : `ReelHouse data layer unavailable: ${boot.detail}`;
    }
    if (mode === "search") {
      if (searchState === "loading") return "Searching";
      if (searchState === "error") return "Search failed";
      if (results) return `Search: ${results.total} matches`;
      return "Search";
    }
    if (boot.phase === "demo") return "Demo library";
    if (boot.phase === "ready") return `Home feed loaded for ${boot.feed.profile?.display_name ?? "your household"}`;
    return "";
  })();

  const heroStyle = hero?.backdropUrl ? { backgroundImage: `url(${hero.backdropUrl})` } : undefined;
  const isLoading = boot.phase === "boot" || boot.phase === "loading";

  return (
    <div ref={rootRef}>
      <p className="sr-only" role="status" aria-live="polite">{statusMessage}</p>
      <main aria-busy={isLoading}>
        <header className="topbar">
          <div className="brand"><span className="brand-mark">R</span><span>REELHOUSE</span></div>
          <nav className="nav-links" aria-label="Library sections">
            {NAV_PRESETS.map((preset) => (
              <button
                key={preset.id}
                data-focus-id={`nav-${preset.id}`}
                tabIndex={focusId === `nav-${preset.id}` ? 0 : -1}
                className={mode === "home" && preset.id === "home" ? "active" : undefined}
                aria-current={mode === "home" && preset.id === "home" ? "page" : undefined}
                onFocus={() => setFocus(`nav-${preset.id}`)}
                onClick={() => (preset.id === "home" ? goHome() : openSearch({ q: "", types: preset.pg, library: null }))}
              >
                {preset.id === "home" && <HomeIcon />} {preset.label}
              </button>
            ))}
          </nav>
          <div className="top-actions">
            <button
              className="icon-button"
              data-focus-id="nav-search"
              tabIndex={focusId === "nav-search" ? 0 : -1}
              aria-label="Search"
              aria-expanded={mode === "search"}
              onFocus={() => setFocus("nav-search")}
              onClick={() => (mode === "search" ? setFocus("search-input") : openSearch({ q: "", types: [], library: null }))}
            >
              <SearchIcon />
            </button>
            <div className="profile-pill" aria-label={activeProfile ? `Profile ${activeProfile.display_name}` : "No profile loaded"}>
              {activeProfile ? (
                <>
                  <span>{activeProfile.initials || activeProfile.display_name.slice(0, 2).toUpperCase()}</span>
                  {activeProfile.display_name}
                </>
              ) : (
                <span className="profile-pill-empty">—</span>
              )}
            </div>
          </div>
        </header>

        {mode === "search" && (
          <section className="search-panel" aria-label="Search">
            <SearchIcon />
            <input
              data-focus-id="search-input"
              tabIndex={focusId === "search-input" ? 0 : -1}
              value={filters.q}
              placeholder="Search movies, shows, home videos…"
              aria-label="Search query"
              onFocus={() => setFocus("search-input")}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
            />
            {(filters.library || filters.types.length > 0) && (
              <button
                className="filter-chip"
                data-focus-id="filter-clear"
                tabIndex={focusId === "filter-clear" ? 0 : -1}
                aria-label="Clear filters"
                onFocus={() => setFocus("filter-clear")}
                onClick={() => openSearch({ q: filters.q, types: [], library: null })}
              >
                {filters.library ? "Library filter ✕" : `${filters.types.join(", ")} ✕`}
              </button>
            )}
            {filters.q && (
              <button aria-label="Clear query" onClick={() => setFilters((current) => ({ ...current, q: "" }))}>Clear</button>
            )}
          </section>
        )}

        {mode === "search" ? (
          <section className="search-results page-gutter" aria-label="Search results">
            <div className="section-heading">
              <h2>Results</h2>
              <span>{results ? `${results.total} matches` : searchState === "loading" ? "…" : ""}</span>
            </div>
            {searchState === "idle" && (
              <p className="empty-note">Type to search your library, or pick Movies / Shows above.</p>
            )}
            {searchState === "loading" && !results && (
              <div className="poster-grid" aria-hidden>
                {Array.from({ length: columns * 2 }, (_, index) => (
                  <div className="skeleton-card" key={index} />
                ))}
              </div>
            )}
            {searchState === "error" && !results && (
              <div className="state-panel">
                <p>Search failed. The data layer may be unavailable.</p>
                <button
                  data-focus-id="search-retry"
                  tabIndex={focusId === "search-retry" ? 0 : -1}
                  onFocus={() => setFocus("search-retry")}
                  onClick={() => setSearchTick((tick) => tick + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {searchState === "empty" && (
              <p className="empty-note">No matches in your catalog{filters.q ? ` for “${filters.q}”` : ""}.</p>
            )}
            {results && results.cards.length > 0 && (
              <>
                <div className="poster-grid">
                  {results.cards.map((card, index) => (
                    <Card
                      key={card.key}
                      card={card}
                      focusId={`result:${index}`}
                      isFocused={focusId === `result:${index}`}
                      onCardFocus={setFocus}
                      onOpen={openDetail}
                    />
                  ))}
                </div>
                {results.hasMore && (
                  <div className="load-more-row">
                    <button
                      data-focus-id="load-more"
                      tabIndex={focusId === "load-more" ? 0 : -1}
                      onFocus={() => setFocus("load-more")}
                      onClick={loadMore}
                    >
                      Load more
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        ) : isLoading ? (
          <div className="content-rail" aria-hidden>
            <div className="skeleton-hero" />
            {[0, 1].map((rail) => (
              <section className="media-section" key={rail}>
                <div className="section-heading page-gutter">
                  <div className="skeleton-bar" style={{ width: 180 }} />
                </div>
                <div className="media-row page-gutter">
                  {Array.from({ length: 7 }, (_, index) => (
                    <div className="skeleton-card" key={index} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : boot.phase === "error" ? (
          <section className="state-panel page-gutter" aria-label="Feed unavailable">
            <h2>{boot.kind === "profile" ? "Profile not found" : "ReelHouse data layer unavailable"}</h2>
            <p>
              {boot.kind === "profile"
                ? `The profile in the URL does not match an active household profile (${boot.detail}).`
                : "Your PostgreSQL catalog could not be reached. Nothing is lost — retry once the database is back."}
            </p>
            <p className="state-detail">{boot.detail}</p>
            <button
              data-focus-id="boot-retry"
              tabIndex={focusId === "boot-retry" ? 0 : -1}
              onFocus={() => setFocus("boot-retry")}
              onClick={() => setRetryTick((tick) => tick + 1)}
            >
              Retry
            </button>
          </section>
        ) : (
          <>
            {banner && <div className={`banner banner-${banner.tone}`} role="status">{banner.message}</div>}
            <section className="hero" style={heroStyle} aria-label="Featured">
              <div className="hero-shade" />
              <div className="hero-content page-gutter">
                {hero ? (
                  <>
                    <p className="eyebrow">{hero.subtitle || "Featured in your library"}</p>
                    <h1>{hero.title}</h1>
                    <p className="hero-meta">
                      {hero.year ?? ""} {hero.rating ? `• ★ ${hero.rating.toFixed(1)}` : ""}
                    </p>
                    <div className="hero-actions">
                      {hero.playHref ? (
                        <a
                          className="primary-button"
                          data-focus-id="hero-play"
                          tabIndex={focusId === "hero-play" ? 0 : -1}
                          href={hero.playHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          onFocus={() => setFocus("hero-play")}
                        >
                          <PlayIcon /> Play in ReelHouse Engine
                        </a>
                      ) : (
                        <button
                          className="primary-button"
                          data-focus-id="hero-play"
                          tabIndex={focusId === "hero-play" ? 0 : -1}
                          onFocus={() => setFocus("hero-play")}
                          onClick={() => openDetail(hero, "hero-play")}
                        >
                          <PlayIcon /> Demo item
                        </button>
                      )}
                      <button
                        className="secondary-button"
                        data-focus-id="hero-info"
                        tabIndex={focusId === "hero-info" ? 0 : -1}
                        onFocus={() => setFocus("hero-info")}
                        onClick={() => openDetail(hero, "hero-info")}
                      >
                        <InfoIcon /> More info
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="eyebrow">Your ReelHouse feed</p>
                    <h1>Nothing here yet</h1>
                    <p className="hero-overview">Run the catalog sync and household import, then reload this page.</p>
                  </>
                )}
              </div>
            </section>

            <div className="content-rail">
              <div className="source-chip-row">
                <div className="source-chip">
                  {boot.phase === "demo"
                    ? "● Demo library • configure DATABASE_URL to load your PostgreSQL catalog"
                    : "● Loaded from your PostgreSQL catalog"}
                </div>
                {unresolvedCount > 0 && (
                  <div className="source-chip source-chip-warn">
                    ⚠ {unresolvedCount} home row{unresolvedCount === 1 ? "" : "s"} could not be resolved
                  </div>
                )}
                {status?.state === "stale" && <div className="source-chip">Catalog data is stale</div>}
              </div>
              {rails.length === 0 && (
                <p className="empty-note page-gutter">
                  Your home rows are empty. Sync the catalog and import your household snapshot to fill this feed.
                </p>
              )}
              {rails.map((rail) => (
                <section className="media-section" key={rail.slug} aria-label={rail.title}>
                  <div className="section-heading page-gutter">
                    <h2>{rail.title}</h2>
                    <button
                      data-focus-id={`${rail.slug}:seeall`}
                      tabIndex={focusId === `${rail.slug}:seeall` ? 0 : -1}
                      onFocus={() => setFocus(`${rail.slug}:seeall`)}
                      onClick={() =>
                        openSearch({ q: "", types: [], library: rail.cards[0]?.libraryJellyfinId ?? null })
                      }
                    >
                      See all ›
                    </button>
                  </div>
                  <div className="media-row page-gutter">
                    {rail.cards.map((card, index) => (
                      <Card
                        key={card.key}
                        card={card}
                        focusId={`${rail.slug}:card:${index}`}
                        isFocused={focusId === `${rail.slug}:card:${index}`}
                        onCardFocus={setFocus}
                        onOpen={openDetail}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {detail && (
          <div
            className="modal-shell"
            role="dialog"
            aria-modal="true"
            aria-label={detail.card.title}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDetail();
            }}
          >
            <section className="details-modal">
              <div
                className="details-backdrop"
                style={
                  (detail.phase === "ready" ? detail.view.backdropUrl : detail.card.backdropUrl)
                    ? { backgroundImage: `url(${detail.phase === "ready" ? detail.view.backdropUrl : detail.card.backdropUrl})` }
                    : undefined
                }
              />
              <button
                className="close"
                data-focus-id="modal-close"
                tabIndex={focusId === "modal-close" ? 0 : -1}
                aria-label="Close details"
                onFocus={() => setFocus("modal-close")}
                onClick={closeDetail}
              >
                ×
              </button>
              {detail.phase === "loading" && (
                <div className="details-copy" aria-hidden>
                  <div className="skeleton-bar" style={{ width: 120 }} />
                  <div className="skeleton-bar skeleton-bar-lg" style={{ width: "60%" }} />
                  <div className="skeleton-bar" style={{ width: "80%" }} />
                  <div className="skeleton-bar" style={{ width: "72%" }} />
                </div>
              )}
              {detail.phase === "missing" && (
                <div className="details-copy">
                  <p className="eyebrow">Catalog churn</p>
                  <h2>{detail.card.title}</h2>
                  <p>This title is no longer in your catalog — it was removed from the library since your last sync.</p>
                </div>
              )}
              {detail.phase === "error" && (
                <div className="details-copy">
                  <p className="eyebrow">Unavailable</p>
                  <h2>{detail.card.title}</h2>
                  <p>ReelHouse could not load details for this title.</p>
                  <p className="state-detail">{detail.detail}</p>
                  <div className="detail-actions">
                    <button
                      className="secondary-button"
                      data-focus-id="modal-retry"
                      tabIndex={focusId === "modal-retry" ? 0 : -1}
                      onFocus={() => setFocus("modal-retry")}
                      onClick={() => openDetail(detail.card, openerRef.current ?? "nav-home")}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
              {detail.phase === "ready" && (
                <div className="details-copy">
                  <p className="eyebrow">
                    {detail.view.kindLabel}
                    {detail.view.year ? ` • ${detail.view.year}` : ""}
                    {detail.view.officialRating ? ` • ${detail.view.officialRating}` : ""}
                  </p>
                  <h2>{detail.view.title}</h2>
                  <div className="metadata">
                    {detail.view.rating !== null && <span>★ {detail.view.rating.toFixed(1)}</span>}
                    {detail.view.genres.slice(0, 4).map((genre) => (
                      <span key={genre}>{genre}</span>
                    ))}
                    {detail.view.libraryName && <span>{detail.view.libraryName}</span>}
                    {detail.view.fileSummary && <span>{detail.view.fileSummary}</span>}
                  </div>
                  <p>{detail.view.overview || "No overview recorded for this title yet."}</p>
                  {detail.view.people.length > 0 && (
                    <p className="detail-people">
                      <strong>People:</strong> {detail.view.people.slice(0, 6).join(" · ")}
                    </p>
                  )}
                  <div className="detail-actions">
                    {detail.view.playHref ? (
                      <a
                        className="primary-button"
                        data-focus-id="modal-play"
                        tabIndex={focusId === "modal-play" ? 0 : -1}
                        href={detail.view.playHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        onFocus={() => setFocus("modal-play")}
                      >
                        <PlayIcon /> Play in ReelHouse Engine
                      </a>
                    ) : (
                      <button className="primary-button" disabled>
                        <PlayIcon /> Demo item
                      </button>
                    )}
                    <button className="secondary-button" onClick={closeDetail}>Close</button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
