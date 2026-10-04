"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { LibraryPayload, MediaItem } from "@/lib/types";
import { demoLibrary } from "@/lib/demo";
import {
  DEFAULT_SPOILER_SHIELD_PREFERENCE,
  SPOILER_SHIELD_COPY,
  isSpoilerShielded,
  readProfileSpoilerShieldPreference,
  writeProfileSpoilerShieldPreference,
  type SpoilerShieldPreference,
  type SpoilerShieldStore
} from "@/lib/spoiler";
import { HomeIcon, InfoIcon, PlayIcon, SearchIcon, ShieldIcon } from "./icons";

const profiles = [
  { name: "V’Ali", initials: "VA" },
  { name: "Nicole", initials: "NF" }
];

function spoilerStore(): SpoilerShieldStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const shieldListeners = new Set<() => void>();

function subscribeToShieldPreference(listener: () => void): () => void {
  shieldListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    shieldListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function setStoredShieldPreference(profile: string, preference: SpoilerShieldPreference): void {
  writeProfileSpoilerShieldPreference(spoilerStore(), profile, preference);
  for (const listener of shieldListeners) listener();
}

type ShieldState = {
  /** This item is inside the shield (unwatched/unknown while the preference is on). */
  protectedItem: boolean;
  /** Synopsis and preview imagery are currently hidden. */
  masked: boolean;
  /** This item was deliberately revealed and can be re-hidden. */
  revealed: boolean;
};

const SHIELD_OFF: ShieldState = { protectedItem: false, masked: false, revealed: false };

function Card({
  item,
  shield,
  onOpen,
  onToggleReveal
}: {
  item: MediaItem;
  shield: ShieldState;
  onOpen: (item: MediaItem) => void;
  onToggleReveal: (id: string) => void;
}) {
  return (
    <div className="media-card-wrap">
      <button
        className="media-card"
        onClick={() => onOpen(item)}
        aria-label={shield.masked ? `Open ${item.title} — spoilers hidden` : `Open ${item.title}`}
      >
        <div className={shield.masked ? "poster spoiler-masked" : "poster"} style={!shield.masked && item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}>
          {shield.masked ? (
            <span className="poster-shield"><ShieldIcon /></span>
          ) : (
            !item.imageUrl && <span>{item.title.slice(0, 1)}</span>
          )}
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
      {shield.protectedItem && (
        <button
          className="reveal-chip"
          onClick={() => onToggleReveal(item.id)}
          aria-pressed={shield.revealed}
          aria-label={shield.revealed ? `Hide spoilers for ${item.title}` : `Reveal spoilers for ${item.title}`}
        >
          {shield.revealed ? SPOILER_SHIELD_COPY.hideItem : SPOILER_SHIELD_COPY.revealItem}
        </button>
      )}
    </div>
  );
}

function Details({
  item,
  shield,
  onToggleReveal,
  onClose
}: {
  item: MediaItem;
  shield: ShieldState;
  onToggleReveal: (id: string) => void;
  onClose: () => void;
}) {
  const jellyfinUrl = process.env.NEXT_PUBLIC_JELLYFIN_URL || "http://localhost:8096";
  const target = item.id.startsWith("demo-") ? undefined : `${jellyfinUrl}/web/index.html#!/details?id=${encodeURIComponent(item.id)}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-shell" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <section className="details-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="details-backdrop"
          style={!shield.masked && item.backdropUrl ? { backgroundImage: `url(${item.backdropUrl})` } : undefined}
        />
        <button className="close" onClick={onClose}>×</button>
        <div className="details-copy">
          <p className="eyebrow">{item.kind} {item.year ? `• ${item.year}` : ""}</p>
          <h2>{item.title}</h2>
          <div className="metadata">
            {item.rating && <span>★ {item.rating.toFixed(1)}</span>}
            {(item.genres || []).slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          {shield.masked ? (
            <p className="spoiler-masked-text">{SPOILER_SHIELD_COPY.maskedSynopsis}</p>
          ) : (
            <p>{item.overview || "Metadata will appear here after ReelHouse connects to your Jellyfin library."}</p>
          )}
          <div className="detail-actions">
            {target ? <a className="primary-button" href={target}><PlayIcon /> Play in ReelHouse Engine</a> : <button className="primary-button" disabled><PlayIcon /> Demo item</button>}
            <button className="secondary-button">＋ Watchlist</button>
            {shield.protectedItem && (
              <button
                className="secondary-button"
                onClick={() => onToggleReveal(item.id)}
                aria-pressed={shield.revealed}
              >
                {shield.revealed ? SPOILER_SHIELD_COPY.hideSpoilers : SPOILER_SHIELD_COPY.revealSpoilers}
              </button>
            )}
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
  // Reveals are ephemeral session state and never cross profiles: switching
  // profiles clears them, and they reset whenever the shield toggles.
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(new Set());
  const spoilerShield = useSyncExternalStore(
    subscribeToShieldPreference,
    () => readProfileSpoilerShieldPreference(spoilerStore(), activeProfile.name),
    () => DEFAULT_SPOILER_SHIELD_PREFERENCE
  );

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

  const shieldFor = useCallback(
    (item: MediaItem): ShieldState => {
      if (spoilerShield !== "shield" || item.watched === true) return SHIELD_OFF;
      const revealed = revealedIds.has(item.id);
      return {
        protectedItem: true,
        masked: isSpoilerShielded(item, spoilerShield, revealed),
        revealed
      };
    },
    [spoilerShield, revealedIds]
  );

  const toggleReveal = useCallback((id: string) => {
    setRevealedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const switchProfile = useCallback((profile: (typeof profiles)[number]) => {
    setActiveProfile(profile);
    setRevealedIds(new Set());
  }, []);

  const toggleSpoilerShield = useCallback(() => {
    setStoredShieldPreference(activeProfile.name, spoilerShield === "shield" ? "show" : "shield");
    setRevealedIds(new Set());
  }, [activeProfile.name, spoilerShield]);

  const heroShield = shieldFor(library.hero);
  const heroStyle = useMemo(
    () => (!heroShield.masked && library.hero.backdropUrl ? { backgroundImage: `url(${library.hero.backdropUrl})` } : undefined),
    [library.hero, heroShield.masked]
  );

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">R</span><span>REELHOUSE</span></div>
        <nav className="nav-links">
          <button className="active"><HomeIcon /> Home</button>
          <button>Movies</button><button>Shows</button><button>Home Videos</button>
        </nav>
        <div className="top-actions">
          <button className="icon-button" aria-label="Search" onClick={() => setSearchOpen((v) => !v)}><SearchIcon /></button>
          <button
            className={spoilerShield === "shield" ? "shield-toggle on" : "shield-toggle"}
            onClick={toggleSpoilerShield}
            aria-pressed={spoilerShield === "shield"}
            aria-label={`Spoiler shield for ${activeProfile.name}: ${spoilerShield === "shield" ? "on" : "off"}`}
            title={`Spoiler shield for ${activeProfile.name} — hides synopses and previews for unwatched titles`}
          >
            <ShieldIcon />
            <span className="shield-label">Shield {spoilerShield === "shield" ? "on" : "off"}</span>
          </button>
          <div className="profile-switcher">
            <button className="profile-pill"><span>{activeProfile.initials}</span>{activeProfile.name}</button>
            <div className="profile-menu">
              {profiles.map((p) => (
                <button key={p.name} onClick={() => switchProfile(p)}>
                  <span>{p.initials}</span>{p.name}
                </button>
              ))}
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
          <div className="poster-grid">
            {searchItems.map((item) => (
              <Card key={item.id} item={item} shield={shieldFor(item)} onOpen={setSelected} onToggleReveal={toggleReveal} />
            ))}
          </div>
        </section>
      ) : <>
        <section className="hero" style={heroStyle}>
          <div className="hero-shade" />
          <div className="hero-content page-gutter">
            <p className="eyebrow">{heroShield.masked ? "Featured in your library" : library.hero.subtitle || "Featured in your library"}</p>
            <h1>{library.hero.title}</h1>
            <p className="hero-meta">{library.hero.year} {library.hero.rating ? `• ★ ${library.hero.rating.toFixed(1)}` : ""} {(library.hero.genres || []).slice(0,2).map((g) => `• ${g}`).join(" ")}</p>
            {heroShield.masked ? (
              <p className="hero-overview spoiler-masked-text">{SPOILER_SHIELD_COPY.maskedSynopsis}</p>
            ) : (
              <p className="hero-overview">{library.hero.overview}</p>
            )}
            <div className="hero-actions">
              <button className="primary-button" onClick={() => setSelected(library.hero)}><PlayIcon /> Play</button>
              <button className="secondary-button" onClick={() => setSelected(library.hero)}><InfoIcon /> More info</button>
              {heroShield.protectedItem && (
                <button
                  className="secondary-button"
                  onClick={() => toggleReveal(library.hero.id)}
                  aria-pressed={heroShield.revealed}
                >
                  {heroShield.masked ? SPOILER_SHIELD_COPY.revealSynopsis : SPOILER_SHIELD_COPY.hideSynopsis}
                </button>
              )}
            </div>
          </div>
        </section>

        <div className="content-rail">
          <div className="source-chip">{library.source === "jellyfin" ? "● Connected to ReelHouse Engine" : "Demo library • connect Jellyfin to index your NAS"}</div>
          {library.sections.map((section) => <section className="media-section" key={section.title}>
            <div className="section-heading page-gutter"><h2>{section.title}</h2><button>See all ›</button></div>
            <div className="media-row page-gutter">
              {section.items.map((item) => (
                <Card key={`${section.title}-${item.id}`} item={item} shield={shieldFor(item)} onOpen={setSelected} onToggleReveal={toggleReveal} />
              ))}
            </div>
          </section>)}
        </div>
      </>}

      {selected && (
        <Details
          item={selected}
          shield={shieldFor(selected)}
          onToggleReveal={toggleReveal}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}
