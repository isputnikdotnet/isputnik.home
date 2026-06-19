import { useEffect, useState } from "react";
import { ListMusic, Plus, X } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { LibraryNavTabs } from "../library/LibraryNavTabs";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { NewCollectionModal } from "./NewCollectionModal";
import type { CollectionSummary } from "./types";

export function CollectionsPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = () => {
    api<{ collections: CollectionSummary[] }>("/api/collections")
      .then((payload) => setCollections(payload.collections))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load collections"));
  };

  useEffect(load, []);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <LibraryNavTabs active="collections" />

        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Collections</h1>
          </div>
          <button className="primary-button compact-button" onClick={() => setCreating(true)}>
            <Plus size={16} />
            <span>New collection</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title="Collections error">{error}</MessageBox>}

        {collections && collections.length === 0 ? (
          <div className="empty-state library-empty">
            <ListMusic size={58} aria-hidden="true" />
            <h2>No collections yet</h2>
            <p className="muted">Create a collection, then add books to it from any book’s menu.</p>
          </div>
        ) : (
          <div className="audiobook-grid">
            {(collections ?? []).map((collection) => (
              <button
                className="audiobook-card collection-card"
                key={collection.id}
                onClick={() => navigate(`/collections/${collection.id}`)}
              >
                <div className="collection-cover-mosaic" aria-hidden="true">
                  {collection.coverUrls.length > 0 ? (
                    collection.coverUrls.slice(0, 4).map((url, i) => <img src={url} alt="" key={i} />)
                  ) : (
                    <ListMusic size={28} />
                  )}
                </div>
                <div className="audiobook-card-body">
                  <strong>{collection.name}</strong>
                  <span>{collection.itemCount} {collection.itemCount === 1 ? "item" : "items"}</span>
                  {collection.description && <p className="audiobook-card-note">{collection.description}</p>}
                </div>
              </button>
            ))}
            {collections === null && <p className="management-empty">Loading collections…</p>}
          </div>
        )}
      </section>

      {creating && (
        <NewCollectionModal
          onClose={() => setCreating(false)}
          onCreated={(collection) => navigate(`/collections/${collection.id}`)}
        />
      )}
    </DashboardShell>
  );
}
