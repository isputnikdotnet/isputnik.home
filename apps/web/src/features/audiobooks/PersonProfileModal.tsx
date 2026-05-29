import { useEffect, useRef, useState } from "react";
import { Save, Upload, UserRound, X } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";

type PersonProfile = {
  name: string;
  sortName: string | null;
  bio: string | null;
  photoUrl: string | null;
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
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="metadata-modal person-modal" role="dialog" aria-modal="true" aria-label={`Edit ${roleLabel}`}>
        <div className="modal-header">
          <h2>{roleLabel}: {personName}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

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
          {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}

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
                <label className="cover-upload-panel">
                  <Upload size={18} />
                  <span>Choose photo</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleFileChange}
                  />
                </label>
              )}
              <p className="muted" style={{ fontSize: "0.8rem", textAlign: "center" }}>
                JPEG, PNG, or WebP · max 10 MB
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
