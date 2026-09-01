import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookMarked, BookOpenCheck, BookText, Library, PenLine, Route, Sparkles, Star } from "lucide-react";
import { api } from "../../api";
import { SectionNav, type SectionNavGroup } from "../../shared/SectionNav";
import type { StoryCollectionSummary } from "./types";

/** The index page's tallies, shown beside the sidebar's filters. Other Stories
 *  pages mount the nav without them and the numbers simply don't render. */
export interface StoryIndexCounts {
  all: number;
  drafts: number;
  published: number;
  favorites: number;
  journal: number;
  memory: number;
  review: number;
}

// The Stories module's contextual sidebar, the way Gallery and Ebooks have
// theirs. Three families of destinations: the index's status filters (all /
// drafts / published / favorites), the story kinds, and one entry per
// collection the viewer can see — the shelves ARE the section's views.
// Filters and kinds are real addresses (/stories?filter=…, /stories?kind=…)
// so each view can be linked, bookmarked and opened in a new tab.
// Self-fetching so every Stories page can mount it with just the active key.
export function StoriesSectionNav({
  activeKey,
  counts
}: {
  activeKey: string;
  counts?: StoryIndexCounts;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [collections, setCollections] = useState<StoryCollectionSummary[]>([]);

  useEffect(() => {
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => setCollections([])); // the nav degrades to "all stories"
  }, []);

  const groups: SectionNavGroup[] = [
    {
      label: t("common:nav.stories"),
      items: [
        { key: "all", label: t("stories:filters.all"), href: "/stories", icon: BookText, count: counts?.all },
        { key: "drafts", label: t("stories:filters.drafts"), href: "/stories?filter=drafts", icon: PenLine, count: counts?.drafts },
        { key: "published", label: t("stories:filters.published"), href: "/stories?filter=published", icon: BookOpenCheck, count: counts?.published },
        { key: "favorites", label: t("stories:filters.favorites"), href: "/stories?filter=favorites", icon: Star, count: counts?.favorites }
      ]
    },
    {
      label: t("stories:nav.kinds"),
      items: [
        { key: "kind-journal", label: t("stories:kinds.journal.name"), href: "/stories?kind=journal", icon: Route, count: counts?.journal },
        { key: "kind-memory", label: t("stories:kinds.memory.name"), href: "/stories?kind=memory", icon: Sparkles, count: counts?.memory },
        { key: "kind-review", label: t("stories:kinds.review.name"), href: "/stories?kind=review", icon: BookMarked, count: counts?.review }
      ]
    },
    {
      label: t("stories:collections.heading"),
      items: collections.map((collection) => ({
        key: collection.id,
        label: collection.title,
        href: `/stories/collections/${collection.id}`,
        icon: Library,
        count: collection.storyCount
      }))
    }
  ];

  return (
    <SectionNav
      ariaLabel={t("common:nav.stories")}
      groups={groups}
      activeKey={activeKey}
    />
  );
}
