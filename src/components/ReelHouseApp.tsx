"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPayload, MediaItem, MediaKind, SearchPayload } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import { focusInitialIn, moveFocus, reveal } from "@/lib/tvnav";
import { uniqueById } from "@/lib/uniqueById";
import { boundedMessage } from "@/lib/diag";
import { useTvNavigation } from "@/hooks/useTvNavigation";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon } from "./icons";

const profiles = [
  { name: "V’Ali", initials: "VA" },
  { name: "Nicole", initials: "NF" }
];

const SEARCH_PAGE_SIZE = 24;

/** Client-side deadline for one engine request: a slow Jellyfin must surface
 *  as an explicit failure state, never an endless spinner. */
const REQUEST_TIMEOUT_MS = 12_000;
/** Automatic reconnect backoff ladder (ms) while the engine is unreachable. */
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** Quiet health refresh while the engine is healthy, so a later outage is
 *  detected and healed without user interaction. */
const ENGINE_POLL_MS = 60_000;
/** How long the “Reconnected” acknowledgment stays on the source chip. */
const RECOVERY_FLASH_MS = 6_000;

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

  // Server-rendered posters can finish (or fail) before hydration attaches
  // onLoad/onError, so reconcile from the element itself when it attaches.
  const attach = (img: HTMLImageElement | null) => {
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) setReady(true);
    else setFailed(true);
  };

  if (failed) return <PosterFallback title={item.title} />;
  return (
    // Posters load directly from the household's Jellyfin host; routing them
    // through the Next image optimizer is deferred to RH-0013.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={attach}
      className={ready ? "poster-img is-ready" : "poster-img"}
      src={item.imageUrl}
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

type EnginePhase = "connecting" | "ok" | "unavailable" | "stale";
type SearchStatus = "idle" | "loading" | "ready" | "error";

/** Reject malformed API bodies explicitly instead of rendering them. */
function isLibraryPayload(value: unknown): value is LibraryPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as LibraryPayload;
  return (payload.source === "demo" || payload.source === "jellyfin")
    && typeof payload.hero?.title === "string"
    && Array.isArray(payload.sections);
}

function isSearchPayload(value: unknown): value is SearchPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as SearchPayload;
  return (payload.source === "demo" || payload.source === "jellyfin")
    && typeof payload.total === "number"
    && typeof payload.offset === "number"
    && Array.isArray(payload.items);
}

export default function ReelHouseApp() {
  const [library, setLibrary] = useState<LibraryPayload>(demoLibrary);
  // Engine connection lifecycle: connecting → ok, or — when the engine is
  // slow, unreachable, or malformed — unavailable (demo titles stand in) or
  // stale (last-good engine data stays), each with an automatic
  // bounded-backoff reconnect cycle until the engine answers again.
  const [enginePhase, setEnginePhase] = useState<EnginePhase>("connecting");
  const [engineNotice, setEngineNotice] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [reconnected, setReconnected] = useState(false);
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

  const librarySeq = useRef(0);
  const libraryAbort = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const recoveryTimer = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const libraryRef = useRef<LibraryPayload>(demoLibrary);
  const loadLibraryRef = useRef<() => void>(() => {});
  const unmountedRef = useRef(false);

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

    // A hung engine must end in an explicit error, not an eternal spinner.
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    fetch(`/api/search?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.message || `Search failed (HTTP ${response.status}).`);
        }
        if (!isSearchPayload(body)) {
          throw new Error("Search returned malformed data.");
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
        if (requestId !== searchSeq.current) return;
        // Aborted requests are superseded or unmounted, not failed — except
        // a timeout, which is this request's own explicit failure.
        if (controller.signal.aborted && !timedOut) return;
        console.warn("[reelhouse] search failed:", boundedMessage(error));
        setSearchError(timedOut
          ? `Search timed out after ${REQUEST_TIMEOUT_MS / 1000}s — the media engine is slow or unreachable.`
          : error instanceof Error ? error.message : "Search failed.");
        setSearchStatus("error");
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (requestId === searchSeq.current) setLoadingMore(false);
      });
  }, []);

  /** Record an engine failure: surface unavailable (no engine data yet —
   *  demo titles stand in) vs. stale (last-good engine data stays), and keep
   *  the automatic bounded-backoff reconnect cycle running. */
  const failConnection = useCallback((reason: string) => {
    if (unmountedRef.current) return;
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    setReconnectAttempt(attempt);
    setEngineNotice(reason);
    setEnginePhase(libraryRef.current.source === "jellyfin" ? "stale" : "unavailable");
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = window.setTimeout(() => {
      reconnectTimer.current = null;
      loadLibraryRef.current();
    }, RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)]);
  }, []);

  const loadLibrary = useCallback((signal?: AbortSignal) => {
    const requestId = ++librarySeq.current;
    libraryAbort.current?.abort();
    const controller = new AbortController();
    libraryAbort.current = controller;
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }

    // A slow engine must degrade into an explicit failure state instead of
    // holding the connecting chip open forever.
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    fetch("/api/library", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error?.message || `Library failed (HTTP ${response.status}).`);
        }
        if (!isLibraryPayload(body)) {
          throw new Error("Library returned malformed data.");
        }
        return body as LibraryPayload;
      })
      .then((payload) => {
        if (librarySeq.current !== requestId) return;
        if (payload.degraded) {
          // The API answered but the engine behind it is down. Last-good
          // engine data stays on screen (stale); demo titles only replace
          // the screen when there is nothing better to show.
          if (libraryRef.current.source !== "jellyfin") {
            libraryRef.current = payload;
            setLibrary(payload);
          }
          failConnection(payload.degradedReason || "ReelHouse Engine is unreachable.");
          return;
        }
        libraryRef.current = payload;
        setLibrary(payload);
        setEngineNotice(null);
        setEnginePhase("ok");
        if (attemptRef.current > 0) {
          // Recovery: end the reconnect cycle and acknowledge it briefly.
          attemptRef.current = 0;
          setReconnectAttempt(0);
          if (reconnectTimer.current !== null) {
            window.clearTimeout(reconnectTimer.current);
            reconnectTimer.current = null;
          }
          setReconnected(true);
          if (recoveryTimer.current !== null) window.clearTimeout(recoveryTimer.current);
          recoveryTimer.current = window.setTimeout(() => setReconnected(false), RECOVERY_FLASH_MS);
        }
        // Quiet health refresh so a later outage is detected and healed
        // without user interaction.
        if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
        pollTimer.current = window.setTimeout(() => {
          pollTimer.current = null;
          loadLibraryRef.current();
        }, ENGINE_POLL_MS);
      })
      .catch((error: unknown) => {
        if (librarySeq.current !== requestId) return;
        // Aborted loads are superseded or unmounted, not failed — except a
        // timeout, which is this load's own explicit failure.
        if (controller.signal.aborted && !timedOut) return;
        const reason = timedOut
          ? `Media engine timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
          : boundedMessage(error);
        console.warn("[reelhouse] engine connection failed:", reason);
        failConnection(reason);
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (signal) signal.removeEventListener("abort", forwardAbort);
      });
  }, [failConnection]);

  useEffect(() => {
    loadLibraryRef.current = () => loadLibrary();
  }, [loadLibrary]);

  const retryLibrary = useCallback(() => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    const controller = new AbortController();
    loadLibrary(controller.signal);
    return () => controller.abort();
  }, [loadLibrary]);

  useEffect(() => () => {
    unmountedRef.current = true;
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    if (recoveryTimer.current !== null) window.clearTimeout(recoveryTimer.current);
    libraryAbort.current?.abort();
  }, []);

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
        {(enginePhase === "unavailable" || enginePhase === "stale") && <div className={`library-banner page-gutter${enginePhase === "stale" ? " stale" : ""}`} role="alert">
          <span>
            {enginePhase === "stale"
              ? "Lost connection to the ReelHouse API — showing the last synced library."
              : "Couldn’t reach the ReelHouse API — showing demo titles."}
            {engineNotice ? ` (${engineNotice})` : ""}
          </span>
          <button onClick={retryLibrary}>Retry</button>
        </div>}
        <section className="hero">
          {library.hero.backdropUrl && (
            <div
              key={library.hero.backdropUrl}
              className="hero-bg"
              style={{ backgroundImage: `url(${library.hero.backdropUrl})` }}
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

        <div className="content-rail" aria-busy={enginePhase === "connecting"}>
          <div
            className={`source-chip${enginePhase === "unavailable" ? " degraded" : ""}${enginePhase === "stale" ? " stale" : ""}${enginePhase === "connecting" ? " connecting" : ""}${reconnected ? " recovered" : ""}`}
            role="status"
          >
            {enginePhase === "connecting" && <><span className="chip-dot" aria-hidden="true" />Connecting to ReelHouse Engine…</>}
            {enginePhase === "ok" && (reconnected
              ? <><span className="chip-dot" aria-hidden="true" />Reconnected to ReelHouse Engine</>
              : library.source === "jellyfin"
                ? "● Connected to ReelHouse Engine"
                : "Demo library • connect Jellyfin to index your NAS")}
            {enginePhase === "unavailable" && <>● ReelHouse Engine unreachable — demo titles shown{reconnectAttempt > 0 && <> · reconnecting (attempt {reconnectAttempt})…</>}</>}
            {enginePhase === "stale" && <>● Connection lost — showing last synced titles{reconnectAttempt > 0 && <> · reconnecting (attempt {reconnectAttempt})…</>}</>}
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
