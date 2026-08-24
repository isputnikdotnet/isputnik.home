import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Globe, ImagePlus, MapPin, Save, Search, Trash2, UserRound } from "lucide-react";
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
  // The photo tile takes a dropped file directly — clicking it opens the box
  // (which also offers Find online), but a drag doesn't need the detour.
  const [tileDragging, setTileDragging] = useState(false);
  const [tileUploading, setTileUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState(false);
  const [lookingUpLink, setLookingUpLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [candidate, setCandidate] = useState<PersonLookupResult | null>(null);
  // A photo chosen on Find Info is STAGED, not written: it is applied by Save
  // alongside the text fields. Anything else in this dialog that changes the
  // photo (the box, a drop, Remove) writes immediately and clears this, so the
  // two can never both be pending.
  const [pendingPhotoUrl, setPendingPhotoUrl] = useState<string | null>(null);
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
      // The staged photo first: it is a download on the server, so if it fails
      // the profile edit is still untouched and the error names the photo.
      if (pendingPhotoUrl) {
        await api(`/api/library/people/by-name/photo-from-url?${query}`, {
          method: "POST",
          body: JSON.stringify({ url: pendingPhotoUrl })
        });
        setPendingPhotoUrl(null);
      }
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

  // A file dropped straight onto the tile. Same endpoint and same limits the
  // photo box's Upload tab uses — checked here too so a bad drop fails before
  // the bytes go over the wire.
  const uploadDropped = async (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Drop a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("That image is larger than the 10 MB limit.");
      return;
    }
    setTileUploading(true);
    setError("");
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(`/api/library/people/by-name/photo?${query}`, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: await file.arrayBuffer()
      });
      setPhotoUrl(result.photoUrl);
      setPendingPhotoUrl(null); // a real upload supersedes anything staged on Find Info
      setProfile((prev) => prev ? { ...prev, photoUrl: result.photoUrl } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload the photo");
    } finally {
      setTileUploading(false);
    }
  };

  const removePhoto = async () => {
    setRemoving(true);
    setError("");
    try {
      await api(`/api/library/people/by-name/photo?${query}`, { method: "DELETE" });
      setPhotoUrl(null);
      setPendingPhotoUrl(null); // removing beats a staged pick
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

  // Both "use this" actions fill the form and nothing more — the dialog has one
  // commit point, Save changes, and picking something here must not quietly
  // become a write the Cancel button can no longer undo.
  const useCandidateBio = () => {
    if (!candidate?.bio) return;
    setBio(candidate.bio);
  };

  const useCandidatePhoto = () => {
    if (!candidate?.photoUrl) return;
    setPendingPhotoUrl(candidate.photoUrl);
    setPhotoUrl(candidate.photoUrl); // preview only; the server still holds the old one
  };

  const bioMatchesCandidate = Boolean(candidate?.bio) && candidate!.bio!.trim() === bio.trim();
  const photoStaged = Boolean(candidate?.photoUrl) && pendingPhotoUrl === candidate!.photoUrl;
  const stagedCount = (bioMatchesCandidate ? 1 : 0) + (photoStaged ? 1 : 0);

  const roleLabel = role === "author" ? "Author" : role === "narrator" ? "Narrator" : "Person";
  const busy = saving || removing || finding || lookingUpLink || tileUploading;

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
                  className={`person-edit-photo-tile${tileDragging ? " dragging" : ""}`}
                  onClick={() => setPhotoBoxOpen(true)}
                  title="Choose a photo"
                  onDragOver={(event) => { event.preventDefault(); setTileDragging(true); }}
                  onDragLeave={() => setTileDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setTileDragging(false);
                    void uploadDropped(event.dataTransfer.files?.[0]);
                  }}
                >
                  {photoUrl ? (
                    <img src={photoUrl} alt="" />
                  ) : (
                    <>
                      <UserRound size={46} aria-hidden="true" />
                      <span className="person-edit-photo-title">
                        {tileUploading ? "Uploading…" : <>Drag and drop<br />or click to upload</>}
                      </span>
                      <span className="person-edit-photo-hint">JPG, PNG or WEBP<br />Max 10MB</span>
                    </>
                  )}
                </button>
                {photoUrl ? (
                  <Button variant="secondary" danger className="person-edit-photo-button" onClick={() => setRemoveOpen(true)}>
                    <Trash2 size={16} aria-hidden="true" />
                    <span>Remove photo</span>
                  </Button>
                ) : (
                  <Button variant="secondary" className="person-edit-photo-button" onClick={() => setPhotoBoxOpen(true)}>
                    <ImagePlus size={16} aria-hidden="true" />
                    <span>Choose photo</span>
                  </Button>
                )}
              </div>

              <div className="person-edit-fields">
                <label className="field">
                  <span>Name <b className="person-edit-req" aria-hidden="true">*</b></span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required />
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
                  <span className="person-edit-input">
                    <Globe size={17} aria-hidden="true" />
                    <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://agriddle.com" />
                  </span>
                </label>
                <label className="field">
                  <span>Location</span>
                  <span className="person-edit-input">
                    <MapPin size={17} aria-hidden="true" />
                    <input
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Seattle, Washington, USA"
                    />
                  </span>
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
              {/* One obvious way in. The paste-a-link path is the exception —
                  for when the search finds the wrong person — so it sits below
                  as an aside rather than as a second button of equal weight. */}
              <div className="person-find-intro">
                <Search size={26} aria-hidden="true" />
                <p className="person-find-lead">
                  Look <strong>{personName}</strong> up on Wikipedia and Open Library.
                </p>
                <p className="person-find-sub">
                  You choose what to keep — nothing changes until you press Save changes.
                </p>
                <Button variant="primary" onClick={() => void handleFindOnline()} disabled={finding}>
                  <Globe size={16} aria-hidden="true" />
                  <span>{finding ? "Searching…" : candidate ? "Search again" : "Search the web"}</span>
                </Button>
              </div>

              {/* Own state rather than <details>: a closed <details> did not
                  actually hide this row here, leaving a live, tabbable input
                  under a disclosure that read as shut. */}
              <div className="person-find-link">
                <button
                  type="button"
                  className="person-find-link-toggle"
                  onClick={() => setLinkOpen((open) => !open)}
                  aria-expanded={linkOpen}
                >
                  {linkOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                  <span>Found the wrong person? Use a specific page instead</span>
                </button>
                {linkOpen && (
                  <div className="person-find-link-row">
                    <label className="search-field person-lookup-input">
                      <Globe size={16} aria-hidden="true" />
                      <input
                        type="url"
                        value={linkUrl}
                        onChange={(e) => setLinkUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleLookupLink(); }}
                        placeholder="Paste a Wikipedia or Open Library link"
                        aria-label="Profile link"
                      />
                    </label>
                    <Button
                      variant="secondary"
                      onClick={() => void handleLookupLink()}
                      disabled={lookingUpLink || !linkUrl.trim()}
                    >
                      <span>{lookingUpLink ? "Reading…" : "Read page"}</span>
                    </Button>
                  </div>
                )}
              </div>

              {candidate && (
                <div className="person-compare">
                  <div className="person-compare-head">
                    <span>Found on</span>
                    <span className="person-compare-source-tag">{sourceLabel(candidate.source)}</span>
                    {candidate.sourceUrl && (
                      <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a>
                    )}
                  </div>

                  {stagedCount > 0 && (
                    <p className="person-find-staged">
                      {stagedCount === 1 ? "1 change is" : `${stagedCount} changes are`} ready — press
                      {" "}<strong>Save changes</strong> to keep {stagedCount === 1 ? "it" : "them"}.
                    </p>
                  )}

                  <div className="person-compare-field">
                    <span className="person-compare-label">Biography</span>
                    {!candidate.bio ? (
                      <p className="person-find-none">No biography on that page.</p>
                    ) : (
                      <>
                        <div className="person-compare-pair">
                          <div className="person-compare-block">
                            <small>Current</small>
                            <p>{bio.trim() || "Nothing yet"}</p>
                          </div>
                          <div className="person-compare-block found">
                            <small>Found</small>
                            <p>{candidate.bio}</p>
                          </div>
                        </div>
                        {bioMatchesCandidate ? (
                          <span className="person-find-done">
                            <Check size={15} aria-hidden="true" />
                            {profile?.bio?.trim() === candidate.bio.trim() ? "Already saved" : "Added to the form"}
                          </span>
                        ) : (
                          <Button variant="secondary" compact onClick={useCandidateBio}>Use this biography</Button>
                        )}
                      </>
                    )}
                  </div>

                  <div className="person-compare-field">
                    <span className="person-compare-label">Photo</span>
                    {!candidate.photoUrl ? (
                      <p className="person-find-none">No photo on that page.</p>
                    ) : (
                      <>
                        <div className="person-compare-photos">
                          <div className="person-compare-block">
                            <small>Current</small>
                            <span className="compare-cover-frame">
                              {profile?.photoUrl ? <img src={profile.photoUrl} alt="" /> : <UserRound size={20} />}
                            </span>
                          </div>
                          <div className="person-compare-block found">
                            <small>Found</small>
                            <span className="compare-cover-frame">
                              <img src={candidate.photoUrl} alt="" />
                            </span>
                          </div>
                        </div>
                        {photoStaged ? (
                          <span className="person-find-done">
                            <Check size={15} aria-hidden="true" />
                            Ready to save
                          </span>
                        ) : (
                          <Button variant="secondary" compact onClick={useCandidatePhoto}>Use this photo</Button>
                        )}
                      </>
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
            setPendingPhotoUrl(null); // the box wrote it already
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
