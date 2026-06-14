import { useEffect, useMemo, useState } from "react";
import { Tag as TagIcon } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "./AudiobooksPage";

interface TagSummary {
  name: string;
  count: number;
}

// Global, cross-type tag browse: a searchable cloud of every tag used across the
// user's book-like libraries, each linking to its cross-type detail page.
export function TagListPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<{ tags: TagSummary[] }>("/api/library/tags")
      .then((payload) => setTags(payload.tags))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load tags"));
  }, []);

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () => (term ? tags.filter((tag) => tag.name.toLowerCase().includes(term)) : tags),
    [tags, term]
  );

  return (
    <DashboardShell active="tags" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Tags"
          subtitle={`${tags.length} ${tags.length === 1 ? "tag" : "tags"}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search tags..."
        />

        {error && <MessageBox tone="error" title="Tags error">{error}</MessageBox>}

        {shown.length === 0 ? (
          <p className="management-empty">{tags.length === 0 ? "No tags yet." : "No tags match your search."}</p>
        ) : (
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
                <span className="tag-cloud-count">{tag.count}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
