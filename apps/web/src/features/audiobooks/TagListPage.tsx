import { useEffect, useMemo, useState } from "react";
import { BookOpen, Headphones, Images, Tag as TagIcon, TreeDeciduous } from "lucide-react";
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
// with the tag detail page so both read the same vocabulary.
export const TAG_SCOPES: {
  value: TagScope;
  label: string;
  icon: typeof BookOpen | null;
  countOf: (tag: TagSummary) => number;
}[] = [
  { value: "all", label: "All", icon: null, countOf: (tag) => tag.count },
  { value: "audiobook", label: "Audiobooks", icon: Headphones, countOf: (tag) => tag.audiobookCount },
  { value: "ebook", label: "Ebooks", icon: BookOpen, countOf: (tag) => tag.ebookCount },
  { value: "gallery", label: "Gallery", icon: Images, countOf: (tag) => tag.galleryCount },
  { value: "family", label: "Family tree", icon: TreeDeciduous, countOf: (tag) => tag.familyCount }
];

// Global, cross-type tag browse: a searchable cloud of every tag in use, across
// books, the gallery, and the family tree, each linking to its detail page.
export function TagListPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<TagScope>("all");
  const [sort, setSort] = useState<TagSort>("count");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api<{ tags: TagSummary[] }>("/api/library/tags")
      .then((payload) => setTags(payload.tags))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tags"));
  }, []);

  // Toggle counts are how many TAGS each scope holds — the cloud lists tags, so
  // that is what the number beside the label has to mean.
  const scopeCounts = useMemo(
    () => TAG_SCOPES.map((s) => ({ ...s, tagCount: tags.filter((tag) => s.countOf(tag) > 0).length })),
    [tags]
  );
  const activeScope = TAG_SCOPES.find((s) => s.value === scope) ?? TAG_SCOPES[0];

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
          title="Tags"
          subtitle={`${tags.length} ${tags.length === 1 ? "tag" : "tags"}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search tags..."
        />

        {error && <MessageBox tone="error" title="Tags error">{error}</MessageBox>}

        <div className="tag-filter-row">
          <div className="kind-toggle" role="group" aria-label="Filter tags by where they are used">
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
            aria-label="Sort tags"
          >
            <option value="count">Sort: Most used</option>
            <option value="name">Sort: A–Z</option>
          </select>
        </div>

        {shown.length === 0 ? (
          <p className="management-empty">
            {tags.length === 0
              ? "No tags yet."
              : term
                ? "No tags match your search."
                : "No tags here yet."}
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
                  Show all {matching.length} tags
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
