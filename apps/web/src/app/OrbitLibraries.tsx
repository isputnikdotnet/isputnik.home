import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, ChevronRight, Clapperboard, Gamepad2, Headphones, Image } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api";
import audiobooksArt from "../assets/library/audiobooks.webp";
import ebooksArt from "../assets/library/ebooks.webp";
import gamesArt from "../assets/library/games.webp";
import photosArt from "../assets/library/photos.webp";
import videoArt from "../assets/library/video.webp";
import { gamesWaiting, useGamesSummary } from "../features/games/useGamesSummary";
import { VIDEO_API } from "../features/video/types";
import { followRoute } from "../router";
import { Button } from "../shared/Button";
import { useSections } from "./sections";
import { useGamesAvailable } from "./useGamesAvailable";
import { useVideoAvailable } from "./useVideoAvailable";

type LibraryKey = "audiobooks" | "ebooks" | "photos" | "video" | "games";

interface LibraryCard {
  key: LibraryKey;
  label: string;
  /** "221 titles", or what the card offers when there is nothing to count. */
  sub: string | null;
  href: string;
  art: string;
  icon: LucideIcon;
  /** A separate app on this origin: a plain link, never a route of this SPA. */
  external: boolean;
  badge: number;
}

type Counts = Partial<Record<LibraryKey, number>>;

// How much is in each library, for this person. Asked once per page load: home
// answers for what it keeps, and the engine for video once video is known to be here.
let ownCounts: Promise<Counts> | null = null;
let videoCount: Promise<number | undefined> | null = null;

function loadOwnCounts(): Promise<Counts> {
  ownCounts ??= api<Counts>("/api/home/libraries").catch((): Counts => ({}));
  return ownCounts;
}

function loadVideoCount(): Promise<number | undefined> {
  const titles = (kind: "movies" | "shows") => api<{ total: number }>(`${VIDEO_API}/${kind}?pageSize=1`).then((page) => page.total).catch(() => undefined);
  videoCount ??= Promise.all([titles("movies"), titles("shows")])
    .then(([movies, shows]) => (movies === undefined && shows === undefined ? undefined : (movies ?? 0) + (shows ?? 0)));
  return videoCount;
}

// The digital libraries this person has, with their pictures and counts. Sections
// switched off, and apps not set up here, are simply not among them.
function useLibraryCards(): LibraryCard[] {
  const { t } = useTranslation();
  const sections = useSections();
  const videoAvailable = useVideoAvailable();
  const gamesAvailable = useGamesAvailable();
  const waiting = gamesWaiting(useGamesSummary());
  const [known, setKnown] = useState<Counts>({});
  const videoOn = videoAvailable && sections.video;

  useEffect(() => {
    let live = true;
    void loadOwnCounts().then((own) => { if (live) setKnown((current) => ({ ...current, ...own })); });
    if (videoOn) void loadVideoCount().then((video) => { if (live) setKnown((current) => ({ ...current, video })); });
    return () => { live = false; };
  }, [videoOn]);

  const titles = (count: number | undefined) => (count === undefined ? null : t("orbit.titlesCount", { count }));
  const cards: (LibraryCard | false)[] = [
    sections.audiobooks && { key: "audiobooks", label: t("nav.audiobooks"), sub: titles(known.audiobooks), href: "/audiobooks", art: audiobooksArt, icon: Headphones, external: false, badge: 0 },
    sections.ebooks && { key: "ebooks", label: t("nav.ebooks"), sub: titles(known.ebooks), href: "/ebooks", art: ebooksArt, icon: BookOpen, external: false, badge: 0 },
    sections.gallery && { key: "photos", label: t("nav.photos"), sub: known.photos === undefined ? null : t("orbit.photosCount", { count: known.photos }), href: "/gallery", art: photosArt, icon: Image, external: false, badge: 0 },
    videoOn && { key: "video", label: t("nav.video"), sub: titles(known.video), href: "/videos", art: videoArt, icon: Clapperboard, external: false, badge: 0 },
    gamesAvailable && sections.games && { key: "games", label: t("nav.games"), sub: t("orbit.gamesSub"), href: "/games/", art: gamesArt, icon: Gamepad2, external: true, badge: waiting }
  ];
  return cards.filter((card): card is LibraryCard => Boolean(card));
}

export function LibraryCards({ onPick }: { onPick?: () => void }) {
  const cards = useLibraryCards();
  return (
    <div className="orbit-library-cards">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <a
            key={card.key}
            className="orbit-library-card"
            href={card.href}
            onClick={(event) => {
              onPick?.();
              if (!card.external) followRoute(event, card.href);
            }}
          >
            <img src={card.art} alt="" />
            <span className="orbit-library-copy">
              <Icon size={24} aria-hidden="true" />
              <span className="orbit-library-text">
                <strong>{card.label}</strong>
                {card.sub && <small>{card.sub}</small>}
              </span>
              {card.badge > 0 && <span className="home-nav-badge">{card.badge}</span>}
              <ChevronRight className="orbit-library-chevron" size={18} aria-hidden="true" />
            </span>
          </a>
        );
      })}
    </div>
  );
}

// The Media menu's list: one plain link per library, its icon, name and count.
// The big picture cards stay on Home; a menu is for getting somewhere quickly.
function LibraryLinks({ current, onPick }: { current: LibraryKey | null; onPick: () => void }) {
  const cards = useLibraryCards();
  return (
    <nav className="orbit-media-links">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <a
            key={card.key}
            className={`orbit-media-link${card.key === current ? " is-active" : ""}`}
            href={card.href}
            aria-current={card.key === current ? "page" : undefined}
            onClick={(event) => {
              onPick();
              if (!card.external) followRoute(event, card.href);
            }}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="orbit-media-link-label">{card.label}</span>
            {card.badge > 0 && <span className="home-nav-badge">{card.badge}</span>}
            {card.sub && <small>{card.sub}</small>}
          </a>
        );
      })}
    </nav>
  );
}

// The bar's Media button: it reads as the library you are in, and opens a short
// list of the libraries. The list asks for its counts only once somebody opens it.
export function OrbitMediaMenu({ current }: { current: { key: LibraryKey; label: string } | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const waiting = gamesWaiting(useGamesSummary());

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="orbit-media" ref={wrap}>
      <Button
        variant="bare"
        className={`orbit-nav-link orbit-media-button${current ? " is-active" : ""}${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{current ? current.label : t("nav.media")}</span>
        {waiting > 0 && <span className="home-nav-badge" title={t("nav.gamesWaiting", { count: waiting })}>{waiting}</span>}
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      {open && (
        <div className="orbit-media-panel">
          <LibraryLinks current={current?.key ?? null} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
