import {
  BookOpen,
  Bookmark,
  ChevronRight,
  FolderOpen,
  Headphones,
  Image,
  Play,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";

type HomeIcon = LucideIcon;

interface LibraryCard {
  title: string;
  subtitle: string;
  progress?: number;
  kind: "audio" | "ebook" | "photo";
  coverClass: string;
  href?: string;
}

interface RecentCard {
  title: string;
  meta: string;
  kind: "audio" | "ebook" | "photo";
  coverClass: string;
  href?: string;
}

interface CollectionCard {
  title: string;
  count: string;
  image: string;
  href?: string;
}

interface OverviewCard {
  label: string;
  value: string;
  href?: string;
  tone: "violet" | "green" | "blue" | "amber" | "rose";
  icon: HomeIcon;
}

const continueItems: LibraryCard[] = [
  {
    title: "Project Hail Mary",
    subtitle: "Andy Weir",
    progress: 67,
    kind: "audio",
    coverClass: "project",
    href: "/audiobooks"
  },
  {
    title: "The Martian",
    subtitle: "Andy Weir",
    progress: 45,
    kind: "audio",
    coverClass: "martian",
    href: "/audiobooks"
  },
  {
    title: "Dune",
    subtitle: "Frank Herbert",
    progress: 23,
    kind: "ebook",
    coverClass: "dune",
    href: "/ebooks"
  },
  {
    title: "Atomic Habits",
    subtitle: "James Clear",
    progress: 89,
    kind: "ebook",
    coverClass: "atomic",
    href: "/ebooks"
  },
  {
    title: "Educated",
    subtitle: "Tara Westover",
    progress: 15,
    kind: "ebook",
    coverClass: "educated",
    href: "/ebooks"
  }
];

const recentItems: RecentCard[] = [
  {
    title: "The Eye of the World",
    meta: "2 hours ago",
    kind: "audio",
    coverClass: "eye",
    href: "/audiobooks"
  },
  {
    title: "The Way of Kings",
    meta: "5 hours ago",
    kind: "ebook",
    coverClass: "kings",
    href: "/ebooks"
  },
  {
    title: "Swiss Trip 2024",
    meta: "Yesterday",
    kind: "photo",
    coverClass: "swiss"
  },
  {
    title: "The Three-Body Problem",
    meta: "2 days ago",
    kind: "audio",
    coverClass: "three-body",
    href: "/audiobooks"
  },
  {
    title: "Sapiens",
    meta: "3 days ago",
    kind: "ebook",
    coverClass: "sapiens",
    href: "/ebooks"
  },
  {
    title: "Family Summer 2024",
    meta: "3 days ago",
    kind: "photo",
    coverClass: "summer"
  }
];

const collectionItems: CollectionCard[] = [
  {
    title: "Sci-Fi",
    count: "1,245 items",
    image: "/Assets/categories/scifi-fantasy-v1.png",
    href: "/audiobooks/categories"
  },
  {
    title: "Fantasy",
    count: "834 items",
    image: "/Assets/categories/adventure-action-v1.png",
    href: "/audiobooks/categories"
  },
  {
    title: "History",
    count: "642 items",
    image: "/Assets/categories/history-v1.png",
    href: "/audiobooks/categories"
  },
  {
    title: "Self-Development",
    count: "667 items",
    image: "/Assets/categories/selfhelp-business-v1.png",
    href: "/audiobooks/categories"
  },
  {
    title: "Family Photos",
    count: "12,345 items",
    image: "/Assets/categories/kids-teens-v1.png"
  },
  {
    title: "Programming",
    count: "432 items",
    image: "/Assets/categories/general-other-v1.png"
  }
];

const overviewItems: OverviewCard[] = [
  {
    label: "Audiobooks",
    value: "3,142",
    href: "/audiobooks",
    tone: "violet",
    icon: Headphones
  },
  {
    label: "Ebooks",
    value: "12,543",
    href: "/ebooks",
    tone: "green",
    icon: BookOpen
  },
  {
    label: "Photos",
    value: "55,231",
    tone: "blue",
    icon: Image
  },
  {
    label: "Documents",
    value: "1,202",
    tone: "amber",
    icon: FolderOpen
  },
  {
    label: "Bookmarks",
    value: "342",
    href: "/audiobooks/saved",
    tone: "rose",
    icon: Bookmark
  }
];

function iconForKind(kind: LibraryCard["kind"]) {
  if (kind === "audio") return Headphones;
  if (kind === "ebook") return BookOpen;
  return Image;
}

function SectionTitle({ id, title, href }: { id: string; title: string; href?: string }) {
  return (
    <div className="home-section-title">
      <h2 id={id}>{title}</h2>
      {href && (
        <a href={href} onClick={(event) => followRoute(event, href)}>
          <span>View all</span>
          <ChevronRight size={18} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function CoverBadge({ kind }: { kind: LibraryCard["kind"] }) {
  const Icon = iconForKind(kind);
  return (
    <span className={`home-cover-badge ${kind}`} aria-hidden="true">
      <Icon size={17} />
    </span>
  );
}

function ContinueCard({ item }: { item: LibraryCard }) {
  const content = (
    <>
      <div className={`home-cover home-cover-${item.coverClass}`}>
        <CoverBadge kind={item.kind} />
        {item.kind === "audio" && (
          <span className="home-play-badge" aria-hidden="true">
            <Play size={18} fill="currentColor" />
          </span>
        )}
        <div className="home-cover-type">{item.kind === "audio" ? "Audio" : item.kind === "ebook" ? "Ebook" : "Photo"}</div>
        <strong>{item.title}</strong>
      </div>
      <div className="home-card-copy">
        <strong>{item.title}</strong>
        <span>{item.subtitle}</span>
      </div>
      {item.progress != null && (
        <div className="home-progress-row" aria-label={`${item.progress}% complete`}>
          <span className="home-progress-track">
            <span style={{ width: `${item.progress}%` }} />
          </span>
          <b>{item.progress}%</b>
        </div>
      )}
    </>
  );

  if (!item.href) {
    return <article className="home-book-card">{content}</article>;
  }

  return (
    <a className="home-book-card" href={item.href} onClick={(event) => followRoute(event, item.href!)}>
      {content}
    </a>
  );
}

function RecentCardView({ item }: { item: RecentCard }) {
  const content = (
    <>
      <div className={`home-recent-cover home-cover-${item.coverClass}`}>
        <CoverBadge kind={item.kind} />
        <strong>{item.title}</strong>
      </div>
      <div className="home-card-copy">
        <strong>{item.title}</strong>
        <span>{item.meta}</span>
      </div>
    </>
  );

  if (!item.href) {
    return <article className="home-recent-card">{content}</article>;
  }

  return (
    <a className="home-recent-card" href={item.href} onClick={(event) => followRoute(event, item.href!)}>
      {content}
    </a>
  );
}

function CollectionCardView({ item }: { item: CollectionCard }) {
  const content = (
    <>
      <div className="home-collection-image">
        <img src={item.image} alt="" />
      </div>
      <div className="home-collection-copy">
        <strong>{item.title}</strong>
        <span>
          <Headphones size={14} aria-hidden="true" />
          {item.count}
        </span>
      </div>
    </>
  );

  if (!item.href) {
    return <article className="home-collection-card">{content}</article>;
  }

  return (
    <a className="home-collection-card" href={item.href} onClick={(event) => followRoute(event, item.href!)}>
      {content}
    </a>
  );
}

function OverviewCardView({ item }: { item: OverviewCard }) {
  const Icon = item.icon;
  const content = (
    <>
      <span className={`home-overview-icon ${item.tone}`} aria-hidden="true">
        <Icon size={25} />
      </span>
      <span>
        <strong>{item.value}</strong>
        <small>{item.label}</small>
      </span>
    </>
  );

  if (!item.href) {
    return <article className="home-overview-card">{content}</article>;
  }

  return (
    <a className="home-overview-card" href={item.href} onClick={(event) => followRoute(event, item.href!)}>
      {content}
    </a>
  );
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  return (
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="home-page" aria-label="Home">
        <header className="home-header">
          <div className="home-heading">
            <h1>Welcome back, {user.displayName}</h1>
            <p>Here's what's happening in your library</p>
          </div>
        </header>

        <div className="home-content">
          <section className="home-section" aria-labelledby="home-continue-title">
            <SectionTitle id="home-continue-title" title="Continue Reading / Listening" href="/audiobooks" />
            <div className="home-book-grid">
              {continueItems.map((item) => (
                <ContinueCard item={item} key={item.title} />
              ))}
            </div>
          </section>

          <section className="home-section" aria-labelledby="home-recent-title">
            <SectionTitle id="home-recent-title" title="Recently Added" href="/audiobooks" />
            <div className="home-recent-grid">
              {recentItems.map((item) => (
                <RecentCardView item={item} key={item.title} />
              ))}
            </div>
          </section>

          <section className="home-section" aria-labelledby="home-collections-title">
            <SectionTitle id="home-collections-title" title="Collections" href="/audiobooks/categories" />
            <div className="home-collection-grid">
              {collectionItems.map((item) => (
                <CollectionCardView item={item} key={item.title} />
              ))}
            </div>
          </section>

          <section className="home-section home-overview-section" aria-labelledby="home-overview-title">
            <SectionTitle id="home-overview-title" title="Library Overview" />
            <div className="home-overview-grid">
              {overviewItems.map((item) => (
                <OverviewCardView item={item} key={item.label} />
              ))}
            </div>
          </section>
        </div>
      </section>
    </DashboardShell>
  );
}
