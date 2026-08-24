import { useRef, useState } from "react";
import { Globe, Upload, UserRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// One photo the online lookup turned up for this name.
type PersonPhotoCandidate = {
  photoUrl: string;
  previewUrl: string;
  label: string;
  hint: string | null;
  sourceUrl: string | null;
};

type Tab = "upload" | "online";

// What the server accepts on PUT .../photo — mirrored here so a bad pick fails
// before the bytes go over the wire.
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

// The "choose a photo" box, opened from the edit dialog's photo tile. Two ways
// in — a file from this computer, or one found online — because an author is
// not a family member: their picture comes from the web or a saved file, never
// from the household gallery.
export function PersonPhotoModal({
  personName,
  currentPhotoUrl,
  onPhotoChanged,
  onClose
}: {
  personName: string;
  currentPhotoUrl: string | null;
  /** Fires with the new URL once the server has stored it. */
  onPhotoChanged: (photoUrl: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("upload");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<{ file: File; preview: string } | null>(null);
  // null = not searched yet; [] = searched and found nothing usable.
  const [candidates, setCandidates] = useState<PersonPhotoCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  // Candidates whose image 404s (Open Library records without a photo do this by
  // design) drop out of the grid rather than showing a broken tile.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const query = `name=${encodeURIComponent(personName)}`;
  const busy = uploading || searching || Boolean(applying);

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPT.includes(file.type)) {
      setError("Choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than the 10 MB limit.");
      return;
    }
    setError("");
    if (pending) URL.revokeObjectURL(pending.preview);
    setPending({ file, preview: URL.createObjectURL(file) });
  };

  const upload = async () => {
    if (!pending) return;
    setUploading(true);
    setError("");
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(`/api/library/people/by-name/photo?${query}`, {
        method: "PUT",
        headers: { "Content-Type": pending.file.type },
        body: await pending.file.arrayBuffer()
      });
      URL.revokeObjectURL(pending.preview);
      setPending(null);
      onPhotoChanged(result.photoUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload the photo");
    } finally {
      setUploading(false);
    }
  };

  const search = async () => {
    setSearching(true);
    setError("");
    try {
      const result = await api<{ candidates: PersonPhotoCandidate[] }>(
        `/api/library/people/by-name/photo-candidates?${query}`
      );
      setCandidates(result.candidates);
      setHidden(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Online lookup failed");
    } finally {
      setSearching(false);
    }
  };

  const apply = async (candidate: PersonPhotoCandidate) => {
    setApplying(candidate.photoUrl);
    setError("");
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(
        `/api/library/people/by-name/photo-from-url?${query}`,
        { method: "POST", body: JSON.stringify({ url: candidate.photoUrl }) }
      );
      onPhotoChanged(result.photoUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to apply that photo");
      setHidden((current) => new Set(current).add(candidate.photoUrl));
    } finally {
      setApplying(null);
    }
  };

  const shown = (candidates ?? []).filter((candidate) => !hidden.has(candidate.photoUrl));
  const previewUrl = pending?.preview ?? currentPhotoUrl;

  return (
    <Modal
      variant="panel"
      title="Choose photo"
      subtitle={personName}
      className="person-photo-modal"
      busy={busy}
      onClose={onClose}
    >
      <div className="modal-tabs">
        <button className={`modal-tab${tab === "upload" ? " active" : ""}`} onClick={() => setTab("upload")}>
          Upload
        </button>
        <button className={`modal-tab${tab === "online" ? " active" : ""}`} onClick={() => setTab("online")}>
          Find online
        </button>
      </div>

      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title="Unable to set the photo">{error}</MessageBox>}

        {tab === "upload" && (
          <div className="person-photo-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT.join(",")}
              hidden
              onChange={(event) => {
                choose(event.target.files?.[0]);
                event.target.value = ""; // let the same file be re-picked
              }}
            />
            <button
              type="button"
              className={`person-photo-drop${dragging ? " dragging" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                choose(event.dataTransfer.files?.[0]);
              }}
            >
              {previewUrl ? (
                <img src={previewUrl} alt="" />
              ) : (
                <>
                  <UserRound size={44} aria-hidden="true" />
                  <span className="person-photo-drop-title">Drag and drop<br />or click to upload</span>
                  <span className="person-photo-drop-hint">JPG, PNG or WEBP<br />Max 10MB</span>
                </>
              )}
            </button>

            {pending && (
              <div className="person-photo-upload-actions">
                <Button variant="primary" onClick={() => void upload()} disabled={uploading}>
                  <Upload size={16} aria-hidden="true" />
                  <span>{uploading ? "Uploading…" : "Use this photo"}</span>
                </Button>
                <Button
                  variant="secondary"
                  disabled={uploading}
                  onClick={() => {
                    URL.revokeObjectURL(pending.preview);
                    setPending(null);
                  }}
                >
                  Choose another
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === "online" && (
          <div className="person-photo-online">
            <div className="person-photo-online-head">
              <p className="muted">Search Wikipedia and Open Library for a picture of {personName}.</p>
              <Button variant="secondary" onClick={() => void search()} disabled={searching}>
                <Globe size={16} aria-hidden="true" />
                <span>{searching ? "Searching…" : candidates ? "Search again" : "Find online"}</span>
              </Button>
            </div>

            {candidates !== null && (
              shown.length > 0 ? (
                <div className="cover-candidate-grid">
                  {shown.map((candidate) => (
                    <button
                      className="cover-candidate"
                      key={candidate.photoUrl}
                      onClick={() => void apply(candidate)}
                      disabled={Boolean(applying)}
                      title={candidate.hint ?? undefined}
                    >
                      <img
                        src={candidate.previewUrl}
                        alt=""
                        onError={() => setHidden((current) => new Set(current).add(candidate.photoUrl))}
                      />
                      <span>{candidate.label}</span>
                      <small>{candidate.hint ?? " "}</small>
                      <strong>{applying === candidate.photoUrl ? "Applying…" : "Use this photo"}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="management-empty">No photos found online for this name.</p>
              )
            )}
          </div>
        )}
      </div>

      <div className="metadata-actions person-edit-footer">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  );
}
