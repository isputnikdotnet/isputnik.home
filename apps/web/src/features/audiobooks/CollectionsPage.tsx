import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader, AudiobookTabs } from "./AudiobooksPage";
import { CategoryIcon } from "./categoryIcons";
import type { LibrarySection } from "./types";

export function CollectionsPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ sections: LibrarySection[] }>("/api/library/sections")
      .then((payload) => setSections(payload.sections))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load collections"));
  }, []);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Collections"
          subtitle={`${sections.length} ${sections.length === 1 ? "collection" : "collections"}`}
        />

        <div className="audiobook-page-nav-row">
          <AudiobookTabs active="collections" />
        </div>

        {error && <MessageBox tone="error" title="Collections error">{error}</MessageBox>}

        {sections.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <FolderOpen size={58} aria-hidden="true" />
            <h2>No collections yet</h2>
            <p className="muted">An administrator can create special audiobook sections from the control panel.</p>
          </div>
        ) : (
          <div className="audiobook-collection-grid">
            {sections.map((section) => (
              <button
                className="audiobook-collection-card"
                key={section.id}
                type="button"
                onClick={() => navigate(`/audiobooks/sections/${section.id}`)}
              >
                <span className="audiobook-collection-icon" aria-hidden="true">
                  <CategoryIcon icon={section.icon} size={30} />
                </span>
                <span>
                  <strong>{section.name}</strong>
                  <small>{section.libraryCount} {section.libraryCount === 1 ? "library" : "libraries"}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
