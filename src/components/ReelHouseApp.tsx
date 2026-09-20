"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryPayload, MediaItem } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon } from "./icons";

const profiles = [
  { name: "V’Ali", initials: "VA" },
  { name: "Nicole", initials: "NF" }
];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function Card({ item, onOpen }: { item: MediaItem; onOpen: (item: MediaItem) => void }) {
  return (
    <button className="media-card" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`} aria-haspopup="dialog">
      <div className="poster" style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
        {!item.imageUrl && <span aria-hidden="true">{item.title.slice(0, 1)}</span>}
        <div className="card-gradient" />
        <div className="card-copy">
          <strong>{item.title}</strong>
          <small>{item.year || item.kind}</small>
        </div>
        {typeof item.progress === "number" && item.progress > 0 && (
          <div
            className="progress"
            role="progressbar"
            aria-label={`Progress through ${item.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(item.progress, 100))}
          ><span style={{ width: `${Math.min(item.progress, 100)}%` }} /></div>
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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current?.focus();
    return () => opener?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const shell = shellRef.current;
    if (!shell) return;
    const focusable = Array.from(shell.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === shell)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-shell"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reelhouse-details-title"
      aria-describedby="reelhouse-details-overview"
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={onClose}
    >
      <section className="details-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="details-backdrop" style={item.backdropUrl ? { backgroundImage: `url(${item.backdropUrl})` } : undefined} />
        <button className="close" onClick={onClose} aria-label="Close details">×</button>
        <div className="details-copy">
          <p className="eyebrow">{item.kind} {item.year ? `• ${item.year}` : ""}</p>
          <h2 id="reelhouse-details-title">{item.title}</h2>
          <div className="metadata">
            {item.rating && <span>★ {item.rating.toFixed(1)}</span>}
            {(item.genres || []).slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p id="reelhouse-details-overview">{item.overview || "Metadata will appear here after ReelHouse connects to your Jellyfin library."}</p>
          <div className="detail-actions">
            {target ? <a className="primary-button" href={target}><PlayIcon /> Play in ReelHouse Engine</a> : <button className="primary-button" disabled><PlayIcon /> Demo item</button>}
            <button className="secondary-button">＋ Watchlist</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function ReelHouseApp() {
  const [library, setLibrary] = useState<LibraryPayload>(demoLibrary);
  const [activeProfile, setActiveProfile] = useState(profiles[0]);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchItems, setSearchItems] = useState<MediaItem[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const profilePillRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetch("/api/library").then((r) => r.json()).then(setLibrary).catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (!search.trim()) return setSearchItems([]);
      fetch(`/api/search?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((x) => setSearchItems(x.items || []))
        .catch(() => undefined);
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [search]);

  const heroStyle = useMemo(() => library.hero.backdropUrl ? { backgroundImage: `url(${library.hero.backdropUrl})` } : undefined, [library.hero]);

  function onSearchBoxKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    if (search) {
      setSearch("");
      searchInputRef.current?.focus();
    } else {
      setSearchOpen(false);
      searchToggleRef.current?.focus();
    }
  }

  return (
    <main id="reelhouse-main">
      <a className="skip-link" href="#reelhouse-main">Skip to content</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><span>REELHOUSE</span></div>
        <nav className="nav-links" aria-label="Primary">
          <button className="active" aria-current="page"><HomeIcon /> Home</button>
          <button>Movies</button><button>Shows</button><button>Home Videos</button>
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            ref={searchToggleRef}
            aria-label={searchOpen ? "Close search" : "Open search"}
            aria-expanded={searchOpen}
            aria-controls="reelhouse-search-panel"
            onClick={() => setSearchOpen((v) => !v)}
          ><SearchIcon /></button>
          <div
            className="profile-switcher"
            data-open={profileOpen || undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setProfileOpen(false); profilePillRef.current?.focus(); }
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setProfileOpen(false);
            }}
          >
            <button
              className="profile-pill"
              ref={profilePillRef}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              aria-controls="reelhouse-profile-menu"
              onClick={() => setProfileOpen((v) => !v)}
            ><span aria-hidden="true">{activeProfile.initials}</span>{activeProfile.name}</button>
            <div className="profile-menu" id="reelhouse-profile-menu" role="menu" aria-label="Switch household profile">
              {profiles.map((p) => (
                <button
                  key={p.name}
                  role="menuitemradio"
                  aria-checked={p.name === activeProfile.name}
                  onClick={() => { setActiveProfile(p); setProfileOpen(false); profilePillRef.current?.focus(); }}
                ><span aria-hidden="true">{p.initials}</span>{p.name}</button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {searchOpen && <section className="search-panel" id="reelhouse-search-panel" role="search" aria-label="Library search">
        <SearchIcon /><input
          ref={searchInputRef}
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchBoxKeyDown}
          placeholder="Search movies, shows, home videos…"
          aria-label="Search movies, shows, home videos"
        />
        {search && <button aria-label="Clear search" onClick={() => { setSearch(""); searchInputRef.current?.focus(); }}>Clear</button>}
      </section>}

      {searchOpen && search.trim() ? (
        <section className="search-results page-gutter">
          <div className="section-heading"><h2>Search results</h2><span aria-live="polite">{searchItems.length} matches</span></div>
          <div className="poster-grid">{searchItems.map((item) => <Card key={item.id} item={item} onOpen={setSelected} />)}</div>
        </section>
      ) : <>
        <section className="hero" style={heroStyle}>
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

        <div className="content-rail">
          <div className="source-chip">{library.source === "jellyfin" ? "● Connected to ReelHouse Engine" : "Demo library • connect Jellyfin to index your NAS"}</div>
          {library.sections.map((section) => <section className="media-section" key={section.title}>
            <div className="section-heading page-gutter"><h2>{section.title}</h2><button aria-label={`See all ${section.title}`}>See all ›</button></div>
            <div className="media-row page-gutter">{section.items.map((item) => <Card key={`${section.title}-${item.id}`} item={item} onOpen={setSelected} />)}</div>
          </section>)}
        </div>
      </>}

      {selected && <Details item={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
