"use client";

import { useEffect, useMemo, useState } from "react";
import type { LibraryPayload, MediaItem } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon } from "./icons";

const profiles = [
  { name: "V’Ali", initials: "VA" },
  { name: "Nicole", initials: "NF" }
];

function Card({ item, onOpen }: { item: MediaItem; onOpen: (item: MediaItem) => void }) {
  return (
    <button className="media-card" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
      <div className="poster" style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
        {!item.imageUrl && <span>{item.title.slice(0, 1)}</span>}
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
  const jellyfinUrl = process.env.NEXT_PUBLIC_JELLYFIN_URL || "http://localhost:8096";
  const target = item.id.startsWith("demo-") ? undefined : `${jellyfinUrl}/web/index.html#!/details?id=${encodeURIComponent(item.id)}`;
  return (
    <div className="modal-shell" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <section className="details-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="details-backdrop" style={item.backdropUrl ? { backgroundImage: `url(${item.backdropUrl})` } : undefined} />
        <button className="close" onClick={onClose}>×</button>
        <div className="details-copy">
          <p className="eyebrow">{item.kind} {item.year ? `• ${item.year}` : ""}</p>
          <h2>{item.title}</h2>
          <div className="metadata">
            {item.rating && <span>★ {item.rating.toFixed(1)}</span>}
            {(item.genres || []).slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p>{item.overview || "Metadata will appear here after ReelHouse connects to your Jellyfin library."}</p>
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

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">R</span><span>REELHOUSE</span></div>
        <nav className="nav-links">
          <button className="active"><HomeIcon /> Home</button>
          <button>Movies</button><button>Shows</button><button>Home Videos</button>
        </nav>
        <div className="top-actions">
          <button className="icon-button" onClick={() => setSearchOpen((v) => !v)}><SearchIcon /></button>
          <div className="profile-switcher">
            <button className="profile-pill"><span>{activeProfile.initials}</span>{activeProfile.name}</button>
            <div className="profile-menu">
              {profiles.map((p) => <button key={p.name} onClick={() => setActiveProfile(p)}><span>{p.initials}</span>{p.name}</button>)}
            </div>
          </div>
        </div>
      </header>

      {searchOpen && <section className="search-panel">
        <SearchIcon /><input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search movies, shows, home videos…" />
        {search && <button onClick={() => setSearch("")}>Clear</button>}
      </section>}

      {searchOpen && search.trim() ? (
        <section className="search-results page-gutter">
          <div className="section-heading"><h2>Search results</h2><span>{searchItems.length} matches</span></div>
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
            <div className="section-heading page-gutter"><h2>{section.title}</h2><button>See all ›</button></div>
            <div className="media-row page-gutter">{section.items.map((item) => <Card key={`${section.title}-${item.id}`} item={item} onOpen={setSelected} />)}</div>
          </section>)}
        </div>
      </>}

      {selected && <Details item={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
