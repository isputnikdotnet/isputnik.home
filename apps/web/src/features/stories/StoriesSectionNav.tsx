import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, Library } from "lucide-react";
import { api } from "../../api";
import { SectionNav, type SectionNavItem } from "../../shared/SectionNav";
import type { StoryCollectionSummary } from "./types";

// The Stories module's contextual sidebar, the way Gallery and Ebooks have
// theirs: all stories, then one entry per collection the viewer can see — the
// shelves ARE the section's views. Dynamic where the gallery's list is fixed,
// but a family's shelf count stays sidebar-sized. Self-fetching so every
// Stories page can mount it with just the active key.
export function StoriesSectionNav({ activeKey }: { activeKey: string }) {
  const { t } = useTranslation(["common", "stories"]);
  const [collections, setCollections] = useState<StoryCollectionSummary[]>([]);

  useEffect(() => {
    api<{ collections: StoryCollectionSummary[] }>("/api/stories/collections")
      .then((payload) => setCollections(payload.collections))
      .catch(() => setCollections([])); // the nav degrades to "all stories"
  }, []);

  const items: SectionNavItem[] = [
    { key: "all", label: t("stories:title"), href: "/stories", icon: BookText },
    ...collections.map((collection) => ({
      key: collection.id,
      label: collection.title,
      href: `/stories/collections/${collection.id}`,
      icon: Library
    }))
  ];

  return (
    <SectionNav
      ariaLabel={t("common:nav.stories")}
      groupLabel={t("common:nav.stories")}
      items={items}
      activeKey={activeKey}
    />
  );
}
