import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Headphones, Images, Tag as TagIcon, TreeDeciduous } from "lucide-react";
import i18n from "../../i18n";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";

// Per-type breakdown so the page can filter the cloud by where a tag is used.
// One tag can span several types at once (a family name that is also an album
// tag), so the scopes overlap by design.
export interface TagSummary {
  name: string;
  count: number;
  audiobookCount: number;
  ebookCount: number;
  galleryCount: number;
  familyCount: number;
}

export type TagScope = "all" | "audiobook" | "ebook" | "gallery" | "family";

type TagSort = "count" | "name";

// A big library runs to hundreds of tags (ebook subject metadata alone brings
// hundreds), which is fine to render but a long scroll. Show the most-used ones
// first and keep the rest one click away.
const TAG_LIMIT = 100;

// Which per-type count each scope reads, and how it labels the toggle. Shared
// with the tag detail page so both read the same vocabulary. Built fresh on
// every call (not a module-level const) so the labels stay reactive to a
// language switch — same approach as control/nav.ts.
export function getTagScopes(): {
  value: TagScope;
  label: string;
  icon: typeof BookOpen | null;
  countOf: (tag: TagSummary) => number;
}[] {
  return [
    { value: "all", label: i18n.t("common:common.all"), icon: null, countOf: (tag) => tag.count },
    { value: "audiobook", label: i18n.t("common:nav.audiobooks"), icon: Headphones, countOf: (tag) => tag.audiobookCount },
    { value: "ebook", label: i18n.t("common:nav.ebooks"), icon: BookOpen, countOf: (tag) => tag.ebookCount },
    { value: "gallery", label: i18n.t("common:nav.gallery"), icon: Images, countOf: (tag) => tag.galleryCount },
    { value: "family", label: i18n.t("common:nav.familyTree"), icon: TreeDeciduous, countOf: (tag) => tag.familyCount }
  ];
}

// Global, cross-type tag browse: a searchable cloud of every tag in use, across
// books, the gallery, and the family tree, each linking to its detail page.
export function TagListPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const { t } = useTranslation(["common", "book"]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<TagScope>("all");
  const [sort, setSort] = useState<TagSort>("count");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api<{ tags: TagSummary[] }>("/api/library/tags")
      .then((payload) => setTags(payload.tags))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:tags.unableLoad")));
  }, []);

  // Toggle counts are how many TAGS each scope holds — the cloud lists tags, so
  // that is what the number beside the label has to mean.
  const tagScopes = getTagScopes();
  const scopeCounts = useMemo(
    () => tagScopes.map((s) => ({ ...s, tagCount: tags.filter((tag) => s.countOf(tag) > 0).length })),
    [tags] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const activeScope = tagScopes.find((s) => s.value === scope) ?? tagScopes[0];

  const term = search.trim().toLowerCase();
  const matching = useMemo(() => {
    const list = tags.filter((tag) =>
      activeScope.countOf(tag) > 0 && (!term || tag.name.toLowerCase().includes(term)));
    return sort === "name"
      ? [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      // Within the active scope, "most used" means that scope's count.
      : [...list].sort((a, b) => activeScope.countOf(b) - activeScope.countOf(a)
        || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [tags, term, activeScope, sort]);

  // Changing what you're looking at starts the list capped again.
  useEffect(() => { setExpanded(false); }, [scope, term, sort]);

  const shown = expanded ? matching : matching.slice(0, TAG_LIMIT);
  const hidden = matching.length - shown.length;

  return (
    <DashboardShell active="tags" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("book:tags.title")}
          subtitle={t("book:catalog.counts.tag", { count: tags.length })}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("book:tags.searchPlaceholder")}
        />

        {error && <MessageBox tone="error" title={t("book:tags.errorTitle")}>{error}</MessageBox>}

        <div className="tag-filter-row">
          <div className="kind-toggle" role="group" aria-label={t("book:tags.filterUsageAria")}>
            {scopeCounts.map(({ value, label, icon: Icon, tagCount }) => (
              <button
                key={value}
                type="button"
                className={scope === value ? "is-active" : ""}
                disabled={tagCount === 0 && value !== "all"}
                onClick={() => setScope(value)}
              >
                {Icon && <Icon size={15} aria-hidden="true" />}
                {label}
                <span className="kind-toggle-count">{tagCount}</span>
              </button>
            ))}
          </div>
          <select
            className="library-filter"
            value={sort}
            onChange={(event) => setSort(event.target.value as TagSort)}
            aria-label={t("book:tags.sortAria")}
          >
            <option value="count">{t("book:tags.sortMostUsed")}</option>
            <option value="name">{t("book:tags.sortAZ")}</option>
          </select>
        </div>

        {shown.length === 0 ? (
          <p className="management-empty">
            {tags.length === 0
              ? t("book:tags.noneYet")
              : term
                ? t("book:tags.noneMatchSearch")
                : t("book:tags.noneHereYet")}
          </p>
        ) : (
          <>
            <div className="tag-cloud">
              {shown.map((tag) => (
                <button
                  key={tag.name}
                  type="button"
                  className="tag-cloud-item"
                  onClick={() => navigate(`/tags/${encodeURIComponent(tag.name)}`)}
                >
                  <TagIcon size={15} aria-hidden="true" />
                  <span>{tag.name}</span>
                  <span className="tag-cloud-count">{activeScope.countOf(tag)}</span>
                </button>
              ))}
            </div>
            {hidden > 0 && (
              <div className="tag-cloud-more">
                <Button variant="secondary" onClick={() => setExpanded(true)}>
                  {t("book:tags.showAllButton", { count: matching.length })}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
