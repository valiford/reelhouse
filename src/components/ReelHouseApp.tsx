"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPayload, MediaItem, MediaKind, SearchPayload } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import { focusInitialIn, moveFocus, reveal } from "@/lib/tvnav";
import { uniqueById } from "@/lib/uniqueById";
import { boundedMessage } from "@/lib/diag";
import { BACKDROP_WIDTHS, POSTER_SIZES, POSTER_WIDTHS, responsiveImage } from "@/lib/poster-image";
import { useTvNavigation } from "@/hooks/useTvNavigation";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon } from "./icons";

const profiles = [
  { name: "V’Ali", initials: "VA" },
  { name: "Nicole", initials: "NF" }
];

const SEARCH_PAGE_SIZE = 24;

const KIND_FILTERS: Array<{ label: string; value: "" | MediaKind }> = [
  { label: "All", value: "" },
  { label: "Movies", value: "Movie" },
  { label: "Series", value: "Series" },
  { label: "Episodes", value: "Episode" },
  { label: "Videos", value: "Video" }
];

function PosterFallback({ title }: { title: string }) {
  return <span className="poster-fallback" aria-hidden="true">{title.slice(0, 1)}</span>;
}

// Keyed by image URL at the call site: a payload swap that repoints an item's
// art remounts this component and re-arms its load/error cycle.
function PosterImage({ item }: { item: MediaItem }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const art = item.imageUrl ? responsiveImage(item.imageUrl, POSTER_WIDTHS) : null;

  // Server-rendered posters can finish (or fail) before hydration attaches
  // onLoad/onError, so reconcile from the element itself when it attaches.
  const attach = (img: HTMLImageElement | null) => {
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) setReady(true);
    else setFailed(true);
  };

  if (failed || !art) return <PosterFallback title={item.title} />;
  return (
    // Posters load directly from the household's Jellyfin host, which resizes
    // and caches per `maxWidth` — the srcSet lets the browser pick the variant
    // matching the rendered slot instead of shipping 600w art to a 150px phone
    // column. Routing art bytes through the Next image optimizer stays
    // rejected: it would spend NAS CPU on a second resizer and move media
    // traffic onto the app server, away from Jellyfin's media authority.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={attach}
      className={ready ? "poster-img is-ready" : "poster-img"}
      src={art.src}
      srcSet={art.srcSet || undefined}
      sizes={art.srcSet ? POSTER_SIZES : undefined}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setReady(true)}
      onError={() => setFailed(true)}
    />
  );
}

function Card({ item, onOpen }: { item: MediaItem; onOpen: (item: MediaItem) => void }) {
  return (
    <button
      className="media-card"
      onClick={() => onOpen(item)}
      onFocus={(e) => reveal(e.currentTarget)}
      aria-label={`Open ${item.title}`}
    >
      <div className="poster">
        {item.imageUrl ? <PosterImage key={item.imageUrl} item={item} /> : <PosterFallback title={item.title} />}
        <div className="card-gradient" />
        <div className="card-copy">
          <strong>{item.title}</strong>
          <small>{item.year || item.kind}</small>
        </div>
        {typeof item.progress === "number" && item.progress > 0 && (
          <div className="progress"><span style={{ width: `${Math.min(item.progress, 100)}%` }} /></div>
        )}
      </div>
    </button>
  );
}

function Details({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const jellyfinUrl = process.env.NEXT_PUBLIC_JELLYFIN_URL || "http://localhost:8096";
  const target = item.id.startsWith("demo-") ? undefined : `${jellyfinUrl}/web/index.html#!/details?id=${encodeURIComponent(item.id)}`;

  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (shellRef.current) focusInitialIn(shellRef.current);
    return () => {
      if (invoker && invoker.isConnected) {
        invoker.focus({ preventScroll: true });
        reveal(invoker);
      }
    };
  }, [item.id]);

  return (
    <div className="modal-shell" ref={shellRef} data-focus-scope role="dialog" aria-modal="true" aria-labelledby="details-title" onMouseDown={onClose}>
      <section className="details-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="details-backdrop" style={item.backdropUrl ? { backgroundImage: `url(${item.backdropUrl})` } : undefined} />
        <button className="close" aria-label="Close details" onClick={onClose}>×</button>
        <div className="details-copy">
          <p className="eyebrow">{item.kind} {item.year ? `• ${item.year}` : ""}</p>
          <h2 id="details-title">{item.title}</h2>
          <div className="metadata">
            {item.rating && <span>★ {item.rating.toFixed(1)}</span>}
            {(item.genres || []).slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p>{item.overview || "Metadata will appear here after ReelHouse connects to your Jellyfin library."}</p>
          <div className="detail-actions">
            {target
              ? <a className="primary-button" href={target} data-autofocus><PlayIcon /> Play in ReelHouse Engine</a>
              : <button className="primary-button" disabled><PlayIcon /> Demo item</button>}
            <button className="secondary-button" data-autofocus={!target}>＋ Watchlist</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function appendUnique(existing: MediaItem[], incoming: MediaItem[]): MediaItem[] {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

export default function ReelHouseApp() {
  const [library, setLibrary] = useState<LibraryPayload>(demoLibrary);
  const [libraryError, setLibraryError] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [activeProfile, setActiveProfile] = useState(profiles[0]);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"" | MediaKind>("");
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchItems, setSearchItems] = useState<MediaItem[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const searchSeq = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);

  const homeRef = useRef<HTMLButtonElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const profilePillRef = useRef<HTMLButtonElement>(null);

  const runSearch = useCallback((term: string, kind: "" | MediaKind, offset: number) => {
    const requestId = ++searchSeq.current;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    const params = new URLSearchParams({ q: term, limit: String(SEARCH_PAGE_SIZE), offset: String(offset) });
    if (kind) params.set("kind", kind);
    if (offset === 0) {
      setSearchStatus("loading");
      setSearchError(null);
    } else {
      setLoadingMore(true);
    }

    fetch(`/api/search?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.message || `Search failed (HTTP ${response.status}).`);
        }
        return body as SearchPayload;
      })
      .then((payload) => {
        // Stale-response guard: only the most recently issued request may
        // touch state, even if an aborted one resolves first.
        if (requestId !== searchSeq.current) return;
        setSearchTotal(payload.total);
        setSearchOffset(payload.offset);
        // First page is replaced wholesale; dedupe keeps a chatty source
        // from rendering twin cards before its own contract does.
        setSearchItems((prev) => payload.offset === 0 ? uniqueById(payload.items) : appendUnique(prev, payload.items));
        setSearchError(null);
        setSearchStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== searchSeq.current) return;
        console.warn("[reelhouse] search failed:", boundedMessage(error));
        setSearchError(error instanceof Error ? error.message : "Search failed.");
        setSearchStatus("error");
      })
      .finally(() => {
        if (requestId === searchSeq.current) setLoadingMore(false);
      });
  }, []);

  const loadLibrary = useCallback((signal?: AbortSignal) => {
    fetch("/api/library", { signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Library failed (HTTP ${response.status}).`);
        return response.json() as Promise<LibraryPayload>;
      })
      .then((payload) => {
        setLibrary(payload);
        setLibraryError(false);
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        console.warn("[reelhouse] library unavailable, showing demo:", boundedMessage(error));
        setLibraryError(true);
      })
      .finally(() => {
        if (!signal?.aborted) setLibraryLoading(false);
      });
  }, []);

  const retryLibrary = useCallback(() => {
    setLibraryLoading(true);
    loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    const controller = new AbortController();
    loadLibrary(controller.signal);
    return () => controller.abort();
  }, [loadLibrary]);

  const resetSearchState = useCallback(() => {
    setSearchStatus("idle");
    setSearchItems([]);
    setSearchTotal(0);
    setSearchOffset(0);
    setSearchError(null);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (!value.trim()) resetSearchState();
  }, [resetSearchState]);

  useEffect(() => {
    const term = search.trim();
    if (!term) {
      searchSeq.current += 1;
      searchAbort.current?.abort();
      return;
    }
    const timer = window.setTimeout(() => runSearch(term, kindFilter, 0), 220);
    return () => {
      window.clearTimeout(timer);
      searchAbort.current?.abort();
    };
  }, [search, kindFilter, runSearch]);

  const retrySearch = useCallback(() => {
    const term = search.trim();
    if (term) runSearch(term, kindFilter, 0);
  }, [search, kindFilter, runSearch]);

  const loadMore = useCallback(() => {
    const term = search.trim();
    if (term) runSearch(term, kindFilter, searchOffset + SEARCH_PAGE_SIZE);
  }, [search, kindFilter, searchOffset, runSearch]);

  useEffect(() => {
    if (!profileOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".profile-switcher")) setProfileOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [profileOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    handleSearchChange("");
    searchToggleRef.current?.focus({ preventScroll: true });
  }, [handleSearchChange]);

  // Back pops the topmost layer only; on home it is a no-op so a stray
  // remote key never leaves the app.
  const handleBack = useCallback((): boolean => {
    if (selected) {
      setSelected(null);
      return true;
    }
    if (searchOpen) {
      closeSearch();
      return true;
    }
    if (profileOpen) {
      setProfileOpen(false);
      profilePillRef.current?.focus({ preventScroll: true });
      return true;
    }
    return false;
  }, [selected, searchOpen, profileOpen, closeSearch]);

  // Enter in the search field commits the query: focus steps into the
  // first result so browsing continues without a pointer.
  const commitSearch = useCallback((): boolean => {
    if (!searchOpen || !searchItems.length) return false;
    return moveFocus("down");
  }, [searchOpen, searchItems]);

  useTvNavigation({ onBack: handleBack, onEnterInText: commitSearch });

  // Deterministic TV entry point: focus lands on Home once per mount
  // when nothing else holds focus.
  useEffect(() => {
    if (document.activeElement === document.body || !document.activeElement) {
      homeRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const searchActive = searchOpen && Boolean(search.trim());
  const showLoadMore = searchStatus === "ready" && searchItems.length > 0 && searchItems.length < searchTotal;
  const heroBackdrop = library.hero.backdropUrl
    ? responsiveImage(library.hero.backdropUrl, BACKDROP_WIDTHS)
    : null;

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">R</span><span>REELHOUSE</span></div>
        <nav className="nav-links" aria-label="Primary">
          <button className="active" ref={homeRef} onFocus={(e) => reveal(e.currentTarget)}><HomeIcon /> Home</button>
          <button onFocus={(e) => reveal(e.currentTarget)}>Movies</button>
          <button onFocus={(e) => reveal(e.currentTarget)}>Shows</button>
          <button onFocus={(e) => reveal(e.currentTarget)}>Home Videos</button>
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            ref={searchToggleRef}
            aria-label="Search"
            aria-expanded={searchOpen}
            aria-controls="reelhouse-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          ><SearchIcon /></button>
          <div className="profile-switcher">
            <button
              className="profile-pill"
              ref={profilePillRef}
              aria-haspopup="true"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen((v) => !v)}
            ><span>{activeProfile.initials}</span>{activeProfile.name}</button>
            <div className={profileOpen ? "profile-menu open" : "profile-menu"}>
              {profiles.map((p) => (
                <button key={p.name} onClick={() => { setActiveProfile(p); setProfileOpen(false); profilePillRef.current?.focus({ preventScroll: true }); }}>
                  <span>{p.initials}</span>{p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {searchOpen && <section className="search-panel" id="reelhouse-search" aria-label="Search library">
        <SearchIcon /><input autoFocus value={search} onChange={(e) => handleSearchChange(e.target.value)} placeholder="Search movies, shows, home videos…" aria-label="Search movies, shows, and home videos" />
        {search && <button onClick={() => handleSearchChange("")}>Clear</button>}
      </section>}

      {searchActive ? (
        <section className="search-results page-gutter" aria-live="polite" aria-busy={searchStatus === "loading"}>
          <div className="search-toolbar">
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.label}
                className={filter.value === kindFilter ? "filter-chip active" : "filter-chip"}
                onClick={() => setKindFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="section-heading">
            <h2>Search results</h2>
            <span>
              {searchStatus === "loading" && "Searching…"}
              {searchStatus === "ready" && (searchTotal > searchItems.length ? `${searchItems.length} of ${searchTotal} matches` : `${searchItems.length} matches`)}
              {searchStatus === "error" && "Search unavailable"}
            </span>
          </div>
          {searchStatus === "loading" && <p className="state-note">Searching for “{search.trim()}”…</p>}
          {searchStatus === "error" && (
            <div className="state-note error-state" role="alert">
              <p>{searchError || "Search is temporarily unavailable."}</p>
              <button onClick={retrySearch}>Retry</button>
            </div>
          )}
          {searchStatus === "ready" && searchItems.length === 0 && (
            <div className="state-note empty-state">
              <p>No matches for “{search.trim()}”{kindFilter ? ` in ${KIND_FILTERS.find((f) => f.value === kindFilter)?.label}` : ""}.</p>
              <p>Try a shorter term or a different type filter.</p>
            </div>
          )}
          {searchItems.length > 0 && (
            <div className="poster-grid">
              {searchItems.map((item) => <Card key={item.id} item={item} onOpen={setSelected} />)}
            </div>
          )}
          {showLoadMore && (
            <div className="load-more-row">
              <button className="secondary-button" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : `Load more (${searchTotal - searchItems.length} remaining)`}
              </button>
            </div>
          )}
        </section>
      ) : <>
        {libraryError && <div className="library-banner page-gutter" role="alert">
          <span>Couldn’t reach the ReelHouse API — showing demo titles.</span>
          <button onClick={retryLibrary}>Retry</button>
        </div>}
        <section className="hero">
          {heroBackdrop && (
            // Hero art is the page's LCP element: eager, high fetch priority,
            // sized to the viewport. The keyed remount keeps the crossfade
            // when the engine payload repoints the backdrop.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={heroBackdrop.src}
              className="hero-bg"
              src={heroBackdrop.src}
              srcSet={heroBackdrop.srcSet || undefined}
              sizes={heroBackdrop.srcSet ? "100vw" : undefined}
              alt=""
              decoding="async"
              fetchPriority="high"
              draggable={false}
            />
          )}
          <div className="hero-shade" />
          <div className="hero-content page-gutter">
            <p className="eyebrow">{library.hero.subtitle || "Featured in your library"}</p>
            <h1>{library.hero.title}</h1>
            <p className="hero-meta">{library.hero.year} {library.hero.rating ? `• ★ ${library.hero.rating.toFixed(1)}` : ""} {(library.hero.genres || []).slice(0,2).map((g) => `• ${g}`).join(" ")}</p>
            <p className="hero-overview">{library.hero.overview}</p>
            <div className="hero-actions">
              <button className="primary-button" onClick={() => setSelected(library.hero)}><PlayIcon /> Play</button>
              <button className="secondary-button" onClick={() => setSelected(library.hero)}><InfoIcon /> More info</button>
            </div>
          </div>
        </section>

        <div className="content-rail" aria-busy={libraryLoading}>
          <div
            className={`source-chip${library.degraded ? " degraded" : ""}${libraryLoading ? " connecting" : ""}`}
            role="status"
          >
            {libraryLoading
              ? <><span className="chip-dot" aria-hidden="true" />Connecting to ReelHouse Engine…</>
              : library.source === "jellyfin"
                ? "● Connected to ReelHouse Engine"
                : library.degraded
                  ? "● ReelHouse Engine unreachable — demo titles shown"
                  : "Demo library • connect Jellyfin to index your NAS"}
          </div>
          {library.sections.map((section) => <section className="media-section" key={section.title}>
            <div className="section-heading page-gutter"><h2>{section.title}</h2><button>See all ›</button></div>
            <div className="media-row page-gutter">{section.items.map((item) => <Card key={`${section.title}-${item.id}`} item={item} onOpen={setSelected} />)}</div>
          </section>)}
          {library.source === "jellyfin" && library.sections.length === 0 && (
            <div className="media-empty page-gutter">
              <p>Connected, but nothing is indexed yet.</p>
              <p>Once the ReelHouse Engine finishes syncing your Jellyfin libraries, your rows will appear here.</p>
            </div>
          )}
        </div>
      </>}

      {selected && <Details item={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
