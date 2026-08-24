import { useEffect, useState } from "react";
import { Globe, ImagePlus, Save, Trash2, UserRound } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonPhotoModal } from "./PersonPhotoModal";

type PersonProfile = {
  name: string;
  sortName: string | null;
  bio: string | null;
  website: string | null;
  location: string | null;
  photoUrl: string | null;
};

type PersonLookupResult = {
  bio: string | null;
  photoUrl: string | null;
  source: "wikipedia" | "openlibrary";
  sourceUrl: string | null;
};

type Tab = "details" | "biography" | "find";

const TABS: { id: Tab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "biography", label: "Biography" },
  { id: "find", label: "Find Info" }
];

// Edit one person's profile. Details carries the identity fields plus the photo
// tile (which opens PersonPhotoModal — choosing a picture is its own box, since
// it has two whole sources of its own); Biography is the long text on its own;
// Find Info looks the person up online and offers what it found field by field.
export function PersonProfileModal({
  personName,
  role,
  onClose
}: {
  personName: string;
  // A person can be credited in several roles across types, so the profile
  // itself is role-agnostic; the prop only tweaks the dialog title.
  role?: "author" | "narrator";
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [name, setName] = useState(personName);
  const [sortName, setSortName] = useState("");
  const [website, setWebsite] = useState("");
  const [location, setLocation] = useState("");
  const [bio, setBio] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBoxOpen, setPhotoBoxOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState(false);
  const [lookingUpLink, setLookingUpLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [candidate, setCandidate] = useState<PersonLookupResult | null>(null);
  const [applyingPhoto, setApplyingPhoto] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "success"; title: string; text: string } | null>(null);

  const query = `name=${encodeURIComponent(personName)}`;

  useEffect(() => {
    api<{ person: PersonProfile | null }>(`/api/library/people/by-name?${query}`)
      .then((payload) => {
        const p = payload.person
          ?? { name: personName, sortName: null, bio: null, website: null, location: null, photoUrl: null };
        setProfile(p);
        setName(p.name);
        setSortName(p.sortName ?? "");
        setWebsite(p.website ?? "");
        setLocation(p.location ?? "");
        setBio(p.bio ?? "");
        setPhotoUrl(p.photoUrl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load profile"));
  }, [personName]);

  const handleSave = async () => {
    const newName = name.trim();
    if (!newName) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/people/by-name?${query}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: newName,
          bio: bio.trim() || null,
          sortName: sortName.trim() || null,
          website: website.trim() || null,
          location: location.trim() || null
        })
      });
      onClose();
      if (newName !== personName) {
        navigate(`/people/${encodeURIComponent(newName)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  };

  const removePhoto = async () => {
    setRemoving(true);
    setError("");
    try {
      await api(`/api/library/people/by-name/photo?${query}`, { method: "DELETE" });
      setPhotoUrl(null);
      setProfile((prev) => prev ? { ...prev, photoUrl: null } : prev);
      setRemoveOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove the photo");
    } finally {
      setRemoving(false);
    }
  };

  // Preview a match without writing anything — by name, or from a pasted
  // Wikipedia / Open Library link. The result shows as current-vs-found and the
  // user applies the bio and/or the photo from there.
  const runLookup = async (url?: string) => {
    setError("");
    setNotice(null);
    const search = url ? `${query}&url=${encodeURIComponent(url)}` : query;
    const result = await api<{ candidate: PersonLookupResult | null }>(`/api/library/people/by-name/lookup?${search}`);
    if (!result.candidate || (!result.candidate.bio && !result.candidate.photoUrl)) {
      setCandidate(null);
      setNotice({
        tone: "info",
        title: "No match found",
        text: url ? "Couldn't read a profile from that link." : "Nothing found online for this name."
      });
      return;
    }
    setCandidate(result.candidate);
  };

  const handleFindOnline = async () => {
    setFinding(true);
    try {
      await runLookup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Online lookup failed");
    } finally {
      setFinding(false);
    }
  };

  const handleLookupLink = async () => {
    if (!linkUrl.trim()) return;
    setLookingUpLink(true);
    try {
      await runLookup(linkUrl.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that link");
    } finally {
      setLookingUpLink(false);
    }
  };

  const sourceLabel = (source: PersonLookupResult["source"]) =>
    source === "openlibrary" ? "Open Library" : "Wikipedia";

  const useCandidateBio = () => {
    if (!candidate?.bio) return;
    setBio(candidate.bio);
    setTab("biography");
    setNotice({ tone: "success", title: "Bio applied", text: "Review it, then Save changes to keep it." });
  };

  const useCandidatePhoto = async () => {
    if (!candidate?.photoUrl) return;
    setApplyingPhoto(true);
    setError("");
    setNotice(null);
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(
        `/api/library/people/by-name/photo-from-url?${query}`,
        { method: "POST", body: JSON.stringify({ url: candidate.photoUrl }) }
      );
      setPhotoUrl(result.photoUrl);
      setProfile((prev) => prev ? { ...prev, photoUrl: result.photoUrl } : prev);
      setNotice({ tone: "success", title: "Photo updated", text: `Applied the ${sourceLabel(candidate.source)} photo.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to apply the photo");
    } finally {
      setApplyingPhoto(false);
    }
  };

  const roleLabel = role === "author" ? "Author" : role === "narrator" ? "Narrator" : "Person";
  const busy = saving || removing || finding || lookingUpLink || applyingPhoto;

  return (
    <>
      <Modal
        variant="panel"
        title={`Edit ${roleLabel}`}
        className="person-edit-modal"
        // The photo box opens on top of this one; both listen for Escape on the
        // document, so without this a single press would close them together.
        busy={busy || photoBoxOpen || removeOpen}
        onClose={onClose}
      >
        <div className="modal-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={`modal-tab${tab === entry.id ? " active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="modal-tab-content">
          {error && <MessageBox tone="error" title="Unable to update profile">{error}</MessageBox>}
          {notice && <MessageBox tone={notice.tone} title={notice.title}>{notice.text}</MessageBox>}

          {tab === "details" && (
            <div className="person-edit-details">
              <div className="person-edit-photo-col">
                <span className="person-edit-label">Photo</span>
                {/* The tile is the way in to the photo box rather than a file
                    input of its own — choosing a picture has two sources, so it
                    gets a box instead of a hidden <input> behind a dashed frame. */}
                <button
                  type="button"
                  className="person-edit-photo-tile"
                  onClick={() => setPhotoBoxOpen(true)}
                  title="Choose a photo"
                >
                  {photoUrl ? (
                    <img src={photoUrl} alt="" />
                  ) : (
                    <>
                      <UserRound size={44} aria-hidden="true" />
                      <span className="person-edit-photo-title">Click to choose<br />a photo</span>
                      <span className="person-edit-photo-hint">Upload a file<br />or find one online</span>
                    </>
                  )}
                </button>
                {photoUrl ? (
                  <Button variant="secondary" danger onClick={() => setRemoveOpen(true)}>
                    <Trash2 size={16} aria-hidden="true" />
                    <span>Remove photo</span>
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setPhotoBoxOpen(true)}>
                    <ImagePlus size={16} aria-hidden="true" />
                    <span>Choose photo</span>
                  </Button>
                )}
              </div>

              <div className="person-edit-fields">
                <label className="field">
                  <span>Name *</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
                </label>
                <label className="field">
                  <span>Sort name</span>
                  <input
                    value={sortName}
                    onChange={(e) => setSortName(e.target.value)}
                    placeholder={`e.g. ${personName.split(" ").reverse().join(", ")}`}
                  />
                </label>
                <label className="field">
                  <span>Website</span>
                  <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="e.g. agriddle.com" />
                </label>
                <label className="field">
                  <span>Location</span>
                  <input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. Seattle, Washington, USA"
                  />
                </label>
              </div>
            </div>
          )}

          {tab === "biography" && (
            <label className="field">
              <span>Biography</span>
              <textarea
                rows={12}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Write a short biography…"
                maxLength={10000}
              />
            </label>
          )}

          {tab === "find" && (
            <div className="person-lookup">
              <div className="person-lookup-bar">
                <Button variant="secondary" compact onClick={() => void handleFindOnline()} disabled={finding}>
                  <Globe size={16} aria-hidden="true" />
                  <span>{finding ? "Searching…" : "Find online"}</span>
                </Button>
                <label className="search-field person-lookup-input">
                  <Globe size={16} aria-hidden="true" />
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleLookupLink(); }}
                    placeholder="…or paste a Wikipedia / Open Library link"
                    aria-label="Profile link"
                  />
                </label>
                <Button
                  variant="secondary"
                  compact
                  onClick={() => void handleLookupLink()}
                  disabled={lookingUpLink || !linkUrl.trim()}
                >
                  <Globe size={16} aria-hidden="true" />
                  <span>{lookingUpLink ? "Looking up…" : "Look up"}</span>
                </Button>
              </div>

              {candidate && (
                <div className="person-compare">
                  <div className="person-compare-head">
                    <span>Found online</span>
                    <span className="person-compare-source-tag">{sourceLabel(candidate.source)}</span>
                    {candidate.sourceUrl && (
                      <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a>
                    )}
                  </div>

                  <div className="person-compare-field">
                    <span className="person-compare-label">Biography</span>
                    <div className="person-compare-pair">
                      <div className="person-compare-block">
                        <small>Current</small>
                        <p>{bio || "—"}</p>
                      </div>
                      <div className="person-compare-block found">
                        <small>Found</small>
                        <p>{candidate.bio || "—"}</p>
                      </div>
                    </div>
                    {candidate.bio && candidate.bio.trim() !== bio.trim() && (
                      <Button variant="secondary" compact onClick={useCandidateBio}>Use this bio</Button>
                    )}
                  </div>

                  <div className="person-compare-field">
                    <span className="person-compare-label">Photo</span>
                    <div className="person-compare-photos">
                      <div className="person-compare-block">
                        <small>Current</small>
                        <span className="compare-cover-frame">
                          {photoUrl ? <img src={photoUrl} alt="" /> : <UserRound size={20} />}
                        </span>
                      </div>
                      <div className="person-compare-block found">
                        <small>Found</small>
                        <span className="compare-cover-frame">
                          {candidate.photoUrl ? <img src={candidate.photoUrl} alt="" /> : <UserRound size={20} />}
                        </span>
                      </div>
                    </div>
                    {candidate.photoUrl && (
                      <Button variant="secondary" compact onClick={() => void useCandidatePhoto()} disabled={applyingPhoto}>
                        {applyingPhoto ? "Applying…" : "Use this photo"}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="metadata-actions person-edit-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy || !name.trim()}>
            <Save size={16} aria-hidden="true" />
            <span>{saving ? "Saving…" : "Save changes"}</span>
          </Button>
        </div>
      </Modal>

      {photoBoxOpen && (
        <PersonPhotoModal
          personName={personName}
          currentPhotoUrl={photoUrl}
          onPhotoChanged={(url) => {
            setPhotoUrl(url);
            setProfile((prev) => prev ? { ...prev, photoUrl: url } : prev);
          }}
          onClose={() => setPhotoBoxOpen(false)}
        />
      )}

      {removeOpen && (
        <ConfirmDialog
          title={`Remove the photo for "${personName}"?`}
          confirmLabel="Remove photo"
          busy={removing}
          danger
          onConfirm={() => void removePhoto()}
          onCancel={() => setRemoveOpen(false)}
        >
          The stored image file is deleted. Their books, bio, and every other detail are untouched,
          and you can choose a new photo at any time.
        </ConfirmDialog>
      )}
    </>
  );
}
