import { useEffect, useRef, useState } from "react";
import { Globe, Save, Upload, UserRound } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

type PersonProfile = {
  name: string;
  sortName: string | null;
  bio: string | null;
  photoUrl: string | null;
};

type EnrichResponse = {
  found: boolean;
  updatedBio: boolean;
  updatedPhoto: boolean;
  source: "wikipedia" | "openlibrary" | null;
  person: PersonProfile | null;
};

type PersonPhotoCandidate = {
  photoUrl: string;
  previewUrl: string;
  label: string;
  hint: string | null;
  sourceUrl: string | null;
};

type Tab = "profile" | "photo";

export function PersonProfileModal({
  personName,
  role,
  onClose
}: {
  personName: string;
  role: "author" | "narrator";
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [name, setName] = useState(personName);
  const [bio, setBio] = useState("");
  const [sortName, setSortName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findNotice, setFindNotice] = useState<{ tone: "info" | "success"; title: string; text: string } | null>(null);
  // null = not searched yet; [] = searched, nothing usable.
  const [photoCandidates, setPhotoCandidates] = useState<PersonPhotoCandidate[] | null>(null);
  const [findingPhotos, setFindingPhotos] = useState(false);
  const [applyingPhotoUrl, setApplyingPhotoUrl] = useState<string | null>(null);
  // Candidates whose image failed to load (e.g. Open Library records without a
  // photo 404 by design) — dropped from the grid.
  const [hiddenPhotoUrls, setHiddenPhotoUrls] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const query = `name=${encodeURIComponent(personName)}`;

  useEffect(() => {
    api<{ person: PersonProfile | null }>(`/api/library/people/by-name?${query}`)
      .then((payload) => {
        const p = payload.person ?? { name: personName, sortName: null, bio: null, photoUrl: null };
        setProfile(p);
        setName(p.name);
        setBio(p.bio ?? "");
        setSortName(p.sortName ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load profile"));
  }, [personName]);

  const handleSaveProfile = async () => {
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
          sortName: sortName.trim() || null
        })
      });
      onClose();
      if (newName !== personName) {
        const listBase = role === "author" ? "/audiobooks/authors" : "/audiobooks/narrators";
        navigate(`${listBase}/${encodeURIComponent(newName)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Looks the person up online (Wikipedia / Open Library) and fills the empty
  // fields server-side; existing biography and photo are never replaced.
  const handleFindOnline = async () => {
    setFinding(true);
    setError("");
    setFindNotice(null);
    try {
      const result = await api<EnrichResponse>(`/api/library/people/by-name/enrich?${query}`, { method: "POST" });
      if (result.person) {
        setProfile(result.person);
        if (result.updatedBio && result.person.bio) {
          setBio(result.person.bio);
        }
      }
      if (!result.found) {
        setFindNotice({ tone: "info", title: "No match found", text: "Nothing found online for this name." });
      } else if (result.updatedBio || result.updatedPhoto) {
        const filled = [result.updatedBio ? "biography" : null, result.updatedPhoto ? "photo" : null]
          .filter(Boolean)
          .join(" and ");
        const source = result.source === "openlibrary" ? "Open Library" : "Wikipedia";
        setFindNotice({ tone: "success", title: "Profile updated", text: `Added ${filled} from ${source}.` });
      } else {
        setFindNotice({ tone: "info", title: "Already filled in", text: "Found a match online, but the biography and photo are already set." });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Online lookup failed");
    } finally {
      setFinding(false);
    }
  };

  const handleFindPhotos = async () => {
    setFindingPhotos(true);
    setError("");
    setFindNotice(null);
    try {
      const result = await api<{ candidates: PersonPhotoCandidate[] }>(
        `/api/library/people/by-name/photo-candidates?${query}`
      );
      setPhotoCandidates(result.candidates);
      setHiddenPhotoUrls(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Online lookup failed");
    } finally {
      setFindingPhotos(false);
    }
  };

  const hidePhotoCandidate = (photoUrl: string) => {
    setHiddenPhotoUrls((current) => new Set(current).add(photoUrl));
  };

  const applyPhotoCandidate = async (candidate: PersonPhotoCandidate) => {
    setApplyingPhotoUrl(candidate.photoUrl);
    setError("");
    setFindNotice(null);
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(
        `/api/library/people/by-name/photo-from-url?${query}`,
        { method: "POST", body: JSON.stringify({ url: candidate.photoUrl }) }
      );
      setProfile((prev) => prev ? { ...prev, photoUrl: result.photoUrl } : prev);
      setFindNotice({ tone: "success", title: "Photo updated", text: `Applied the ${candidate.label} photo.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to apply the photo");
      hidePhotoCandidate(candidate.photoUrl);
    } finally {
      setApplyingPhotoUrl(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadFile(file);
    setUploadPreview(URL.createObjectURL(file));
  };

  const handleUploadPhoto = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setError("");
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(
        `/api/library/people/by-name/photo?${query}`,
        {
          method: "PUT",
          headers: { "Content-Type": uploadFile.type },
          body: await uploadFile.arrayBuffer()
        }
      );
      setProfile((prev) => prev ? { ...prev, photoUrl: result.photoUrl } : prev);
      setUploadFile(null);
      if (uploadPreview) URL.revokeObjectURL(uploadPreview);
      setUploadPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setUploading(false);
    }
  };

  const roleLabel = role === "author" ? "Author" : "Narrator";
  const currentPhotoUrl = uploadPreview ?? profile?.photoUrl ?? null;

  return (
    <Modal
      variant="panel"
      title={`${roleLabel}: ${personName}`}
      className="person-modal"
      busy={saving || uploading || finding || findingPhotos || Boolean(applyingPhotoUrl)}
      onClose={onClose}
    >
        <div className="modal-tabs">
          <button
            className={`modal-tab${tab === "profile" ? " active" : ""}`}
            onClick={() => setTab("profile")}
          >
            Profile
          </button>
          <button
            className={`modal-tab${tab === "photo" ? " active" : ""}`}
            onClick={() => setTab("photo")}
          >
            Photo
          </button>
        </div>

        <div className="modal-tab-content">
          {error && <MessageBox tone="error" title="Unable to update profile">{error}</MessageBox>}
          {findNotice && <MessageBox tone={findNotice.tone} title={findNotice.title}>{findNotice.text}</MessageBox>}

          {tab === "profile" && (
            <div className="person-profile-grid">
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                />
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
                <span>Biography</span>
                <textarea
                  rows={7}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Write a short biography…"
                  maxLength={10000}
                />
              </label>
              <div className="metadata-actions">
                <button
                  className="primary-button"
                  onClick={handleSaveProfile}
                  disabled={saving || !name.trim()}
                >
                  <Save size={16} />
                  <span>{saving ? "Saving…" : "Save profile"}</span>
                </button>
                <Button variant="secondary" onClick={handleFindOnline} disabled={finding}>
                  <Globe size={16} />
                  <span>{finding ? "Searching…" : "Find online"}</span>
                </Button>
                <button className="secondary-button" onClick={onClose}>Cancel</button>
              </div>
            </div>
          )}

          {tab === "photo" && (
            <div className="person-photo-tab">
              <div className="person-photo-preview">
                {currentPhotoUrl ? (
                  <img src={currentPhotoUrl} alt={personName} />
                ) : (
                  <UserRound size={52} aria-hidden="true" />
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />

              {uploadFile ? (
                <div className="person-photo-actions">
                  <button
                    className="primary-button"
                    onClick={handleUploadPhoto}
                    disabled={uploading}
                  >
                    <Upload size={16} />
                    <span>{uploading ? "Uploading…" : "Upload photo"}</span>
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setUploadFile(null);
                      if (uploadPreview) URL.revokeObjectURL(uploadPreview);
                      setUploadPreview(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="person-photo-actions">
                  <label className="cover-upload-panel">
                    <Upload size={18} />
                    <span>Choose photo</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleFileChange}
                    />
                  </label>
                  <Button variant="secondary" onClick={handleFindPhotos} disabled={findingPhotos}>
                    <Globe size={16} />
                    <span>{findingPhotos ? "Searching…" : "Find online"}</span>
                  </Button>
                </div>
              )}

              {!uploadFile && photoCandidates !== null && (
                photoCandidates.filter((candidate) => !hiddenPhotoUrls.has(candidate.photoUrl)).length > 0 ? (
                  <div className="cover-candidate-grid person-photo-candidates">
                    {photoCandidates
                      .filter((candidate) => !hiddenPhotoUrls.has(candidate.photoUrl))
                      .map((candidate) => (
                        <button
                          className="cover-candidate"
                          key={candidate.photoUrl}
                          onClick={() => applyPhotoCandidate(candidate)}
                          disabled={Boolean(applyingPhotoUrl)}
                          title={candidate.hint ?? undefined}
                        >
                          <img
                            src={candidate.previewUrl}
                            alt=""
                            onError={() => hidePhotoCandidate(candidate.photoUrl)}
                          />
                          <span>{candidate.label}</span>
                          <small>{candidate.hint ?? " "}</small>
                          <strong>{applyingPhotoUrl === candidate.photoUrl ? "Applying…" : "Use this photo"}</strong>
                        </button>
                      ))}
                  </div>
                ) : (
                  <p className="management-empty">No photos found online for this name.</p>
                )
              )}

              <p className="muted" style={{ fontSize: "0.8rem", textAlign: "center" }}>
                JPEG, PNG, or WebP · max 10 MB
              </p>
            </div>
          )}
        </div>
    </Modal>
  );
}
