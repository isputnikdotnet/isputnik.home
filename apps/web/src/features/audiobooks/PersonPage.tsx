import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookOpen, Merge, Pencil, Search, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { PersonProfileModal } from "./PersonProfileModal";

// One item this person is credited on, in any media type / any accessible
// library. `role` is how they're credited on this specific item.
type PersonItem = {
  id: string;
  type: "audiobook" | "ebook";
  role: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  author: "Author",
  narrator: "Narrator",
  editor: "Editor",
  artist: "Artist",
  photographer: "Photographer",
  contributor: "Contributor"
};

const roleLabel = (role: string) => ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
const typeLabel = (type: string) => (type === "ebook" ? "Ebook" : "Audiobook");
const bookHref = (item: PersonItem) =>
  item.type === "ebook" ? `/ebooks/books/${item.id}` : `/audiobooks/books/${item.id}`;

// The canonical, cross-type person page. People are global (one DB row per
// name), so this shows everything a person made — audiobooks and ebooks —
// grouped by the role they're credited in. Reached via /people/:name and the
// legacy per-type author/narrator paths, which all render this component.
export function PersonPage({
  personName,
  user,
  logout
}: {
  personName: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [items, setItems] = useState<PersonItem[]>([]);
  const [profile, setProfile] = useState<{ bio: string | null; photoUrl: string | null } | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeNames, setMergeNames] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeQuery, setMergeQuery] = useState("");
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");

  const backTo = getReferrer();
  // The page spans types; highlight the nav the visitor most likely came from.
  const dashActive = backTo === "/authors" ? "authors" : backTo?.startsWith("/ebooks") ? "ebooks" : "audiobooks";

  // Photo + bio for the header; re-fetched after the profile modal closes so
  // edits show up immediately.
  const loadProfile = useCallback(async () => {
    try {
      const payload = await api<{ person: { bio: string | null; photoUrl: string | null } | null }>(
        `/api/library/people/by-name?name=${encodeURIComponent(personName)}`
      );
      setProfile(payload.person ?? null);
    } catch {
      setProfile(null); // header degrades to the placeholder icon
    }
  }, [personName]);

  useEffect(() => {
    api<{ items: PersonItem[] }>(`/api/library/people/by-name/items?name=${encodeURIComponent(personName)}`)
      .then((payload) => setItems(payload.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load data"));
    void loadProfile();
    // Merge candidates come from the global people list (admins only need it).
    if (user.role === "admin") {
      api<{ names: string[] }>("/api/library/people/names")
        .then((payload) => setMergeNames(payload.names))
        .catch(() => {}); // merge just stays unavailable if this fails
    }
  }, [personName, loadProfile, user.role]);

  // Group items by role, preserving the server's ordering (author, narrator, …).
  const roles: string[] = [];
  const byRole: Record<string, PersonItem[]> = {};
  for (const item of items) {
    if (!byRole[item.role]) {
      byRole[item.role] = [];
      roles.push(item.role);
    }
    byRole[item.role].push(item);
  }

  const mergeCandidates = mergeNames.filter((name) => name !== personName);
  const filteredCandidates = mergeQuery.trim()
    ? mergeCandidates.filter((name) => name.toLowerCase().includes(mergeQuery.trim().toLowerCase()))
    : mergeCandidates;

  const runMerge = async () => {
    if (!mergeTarget) return;
    setMerging(true);
    setError("");
    try {
      await api("/api/library/people/merge", {
        method: "POST",
        body: JSON.stringify({ from: personName, into: mergeTarget })
      });
      setMergeOpen(false);
      setMerging(false);
      navigate(`/people/${encodeURIComponent(mergeTarget)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
      setMerging(false);
    }
  };

  return (
    <DashboardShell active={dashActive} user={user} logout={logout}>
      <section className="audiobook-main-page">
        <button className="audiobook-back-button" type="button" onClick={() => navigate(backTo ?? "/authors")}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>{backTo ? "Back" : "Back to authors"}</span>
        </button>
        <div className="section-head">
          <div>
            <p className="eyebrow">{items.length} {items.length === 1 ? "title" : "titles"}</p>
            <div className="person-detail-head">
              <div className="person-avatar person-detail-avatar" aria-hidden="true">
                {profile?.photoUrl ? <img src={profile.photoUrl} alt="" /> : <UserRound size={30} />}
              </div>
              <h1>{personName}</h1>
              <button className="icon-button" onClick={() => setProfileModalOpen(true)} title="Edit profile">
                <Pencil size={17} />
              </button>
              {user.role === "admin" && mergeCandidates.length > 0 && (
                <button
                  className="icon-button"
                  onClick={() => { setMergeTarget(""); setMergeQuery(""); setMergeOpen(true); }}
                  title="Merge this person into another"
                >
                  <Merge size={17} />
                </button>
              )}
            </div>
            {profile?.bio && <p className="person-bio">{profile.bio}</p>}
          </div>
        </div>

        {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

        {roles.map((role) => (
          <div className="person-role-group" key={role}>
            <p className="person-book-count muted">
              {roleLabel(role)} · {byRole[role].length} {byRole[role].length === 1 ? "title" : "titles"}
            </p>
            <div className="audiobook-grid">
              {byRole[role].map((item) => (
                <button className="audiobook-card" key={`${role}:${item.id}`} onClick={() => navigate(bookHref(item))}>
                  <div className="audiobook-cover" aria-hidden="true">
                    {item.coverUrl ? (
                      <img src={item.coverUrl} alt="" />
                    ) : (
                      <>
                        <BookOpen size={13} />
                        <strong>{item.title.slice(0, 2).toUpperCase()}</strong>
                      </>
                    )}
                  </div>
                  <div className="audiobook-card-body">
                    <strong>{item.title}</strong>
                    <span>{item.authors.length > 0 ? item.authors.join(", ") : "Unknown author"}</span>
                    <small>{typeLabel(item.type)}</small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      {profileModalOpen && (
        <PersonProfileModal
          personName={personName}
          onClose={() => {
            setProfileModalOpen(false);
            void loadProfile();
          }}
        />
      )}

      {mergeOpen && (
        <Modal title={`Merge “${personName}”`} className="merge-modal" busy={merging} onClose={() => setMergeOpen(false)}>
          <p>
            Pick the person to merge <strong>{personName}</strong> into. Their {items.length} {items.length === 1 ? "title moves" : "titles move"} to
            the chosen name, and future scans will map “{personName}” there automatically.
          </p>
          <label className="facet-search merge-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={mergeQuery}
              onChange={(e) => setMergeQuery(e.target.value)}
              placeholder="Search people"
              aria-label="Search people"
              autoFocus
            />
          </label>
          <div className="merge-candidate-list">
            {filteredCandidates.map((name) => (
              <button
                key={name}
                className={`merge-candidate${mergeTarget === name ? " selected" : ""}`}
                onClick={() => setMergeTarget(name)}
              >
                {name}
              </button>
            ))}
            {filteredCandidates.length === 0 && <p className="facet-empty">No matches</p>}
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setMergeOpen(false)} disabled={merging}>Cancel</Button>
            <Button variant="primary" onClick={runMerge} disabled={merging || !mergeTarget}>
              <Merge size={15} /> {merging ? "Merging…" : "Merge"}
            </Button>
          </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
