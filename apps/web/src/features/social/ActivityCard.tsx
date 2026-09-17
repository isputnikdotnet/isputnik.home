import { BookOpenText, BookText, Film, Images, MessageSquare, Network, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../../router";
import { relativeTime } from "../../shared/relativeTime";
import { activityPhrase, chapterName, type ActivityChapter, type ActivityKind } from "./phrasing";

// What the household has been up to, one card per event in the home feed.
//
// Every kind — a note, an album, a slideshow, a story, an added chapter, a
// person in the family tree — wears the same cover-led card: the picture, who
// did what and when, then the thing itself as the title. They used to be
// one-line sentences with a small thumbnail, which cut the title off on a phone
// (the part that says WHAT happened) and made a new album look like a log line.
//
// The sentence still matters: it is the link's accessible name, so a screen
// reader hears "Dad added Grandma to the family tree" in the right order —
// the title does not always come last.

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  actorName: string;
  createdAt: string;
  /** A note's own words. Null for everything else. */
  body: string | null;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  href: string;
  /** The chapter a story update added; null for every other kind. */
  chapter: ActivityChapter | null;
}

const ICONS: Record<ActivityKind, LucideIcon> = {
  note: MessageSquare,
  album: Images,
  slideshow: Film,
  story: BookText,
  story_update: BookOpenText,
  person: Network
};

export function ActivityFeedCard({ item }: { item: ActivityItem }) {
  const Icon = ICONS[item.kind] ?? MessageSquare;
  // "Dad added Day 4 to Alps in summer": the chapter goes in the sentence's
  // first half, and the story's title is the card's title.
  const phrase = activityPhrase(item.actorName, item.kind, item.chapter ? chapterName(item.chapter) : undefined);
  const lead = phrase.after ? `${phrase.before} ${phrase.after}` : phrase.before;
  const sentence = `${phrase.before} ${item.title}${phrase.after ? ` ${phrase.after}` : ""}`;
  const when = relativeTime(item.createdAt, { style: "short" });

  return (
    <a
      className={`home-card home-card-suggest home-card-activity is-${item.kind}`}
      href={item.href}
      onClick={(event) => followRoute(event, item.href)}
      aria-label={when ? `${sentence}, ${when}` : sentence}
    >
      <span className="home-suggest-cover home-activity-cover">
        {item.coverUrl
          ? <img src={item.coverUrl} alt="" loading="lazy" />
          : <span className="home-memory-fallback"><Icon size={24} aria-hidden="true" /></span>}
        {/* The corner badge says which kind of thing this is at a glance. */}
        <span className="home-activity-badge" aria-hidden="true">
          {item.kind === "slideshow" ? <Play size={11} fill="currentColor" /> : <Icon size={11} />}
        </span>
      </span>
      <span className="home-suggest-copy">
        <small className="home-suggest-why activity-lead">{lead}</small>
        <strong className="home-suggest-title activity-title">{item.title}</strong>
        {/* A note without its words is just "somebody said something". */}
        {item.body && <small className="activity-body">“{item.body}”</small>}
        {/* The time leads the card's last line, not the lead line: after "added
            Day 5 to" it left the sentence hanging on its preposition, and a
            story's subtitle can run to a paragraph, so the line is clamped. */}
        {(when || (item.subtitle && !item.body)) && (
          <small className="home-suggest-series activity-meta">
            {when && <span className="activity-when">{when}</span>}
            {when && item.subtitle && !item.body && " · "}
            {!item.body && item.subtitle}
          </small>
        )}
      </span>
    </a>
  );
}
