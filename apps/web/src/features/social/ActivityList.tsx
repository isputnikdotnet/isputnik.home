import { BookOpenText, BookText, Film, Images, MessageSquare, Network } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followRoute } from "../../router";
import { activityPhrase, chapterName, timeAgo, type ActivityChapter, type ActivityKind } from "./phrasing";

// What the household has been up to, as sentences.
//
// "Anna left a note on Dune" reads as news. A card with a title and a coloured
// badge reads as a database row someone has styled. The sentence is the whole
// design; everything else here is a thumbnail and a timestamp.
//
// Rendered inside the home feed's activity cards — its only surface now.

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

export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ul className="activity-list">
      {items.map((item) => {
        const Icon = ICONS[item.kind] ?? MessageSquare;
        // "Dad added Day 4 to Alps in summer": the chapter goes in the
        // sentence's first half, and the story's title takes the bold slot.
        const phrase = activityPhrase(item.actorName, item.kind, item.chapter ? chapterName(item.chapter) : undefined);
        return (
          <li key={item.id}>
            <a
              className="activity-row"
              href={item.href}
              onClick={(event) => followRoute(event, item.href)}
            >
              <span className="activity-thumb">
                {item.coverUrl
                  ? <img src={item.coverUrl} alt="" loading="lazy" />
                  : <Icon size={18} aria-hidden="true" />}
              </span>

              <span className="activity-copy">
                <span className="activity-sentence">
                  {phrase.before} <strong>{item.title}</strong>
                  {phrase.after && ` ${phrase.after}`}
                </span>
                {/* A note without its words is just "somebody said something". */}
                {item.body && <span className="activity-body">“{item.body}”</span>}
              </span>

              <span className="activity-when">{timeAgo(item.createdAt)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
