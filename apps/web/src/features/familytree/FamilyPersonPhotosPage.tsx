import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ImagePlus, Play } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { FamilyPersonProfile, FamilyPhoto } from "./types";
import { faceFocusStyle } from "../gallery/types";

const PHOTO_PAGE = 60;

// Every photo of one family member — the profile's Photos tab shows a preview
// and links here. Lives in the family tree rather than linking into the gallery
// because the set is a merge the gallery has no view for: curated attachments
// plus whatever the linked face cluster turned up. Photos open in a lightbox on
// this page, so closing one returns here instead of stranding the reader in the
// gallery.
export function FamilyPersonPhotosPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [person, setPerson] = useState<FamilyPersonProfile | null>(null);
  const [photos, setPhotos] = useState<FamilyPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const loadPhotos = useCallback(async (offset: number) => {
    const payload = await api<{ assets: FamilyPhoto[]; total: number }>(
      `/api/family-tree/persons/${id}/photos?limit=${PHOTO_PAGE}&offset=${offset}`
    );
    setPhotos((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
    setTotal(payload.total);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<{ person: FamilyPersonProfile }>(`/api/family-tree/persons/${id}`).then((p) => setPerson(p.person)),
      loadPhotos(0)
    ])
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load photos"))
      .finally(() => setLoading(false));
  }, [id, loadPhotos]);

  const back = `/family/people/${id}`;

  return (
    <DashboardShell active="family" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <div className="book-detail-topbar">
          <a className="audiobook-back-button" href={back} onClick={(event) => followRoute(event, back)}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>Back to {person?.name ?? "profile"}</span>
          </a>
        </div>

        <div className="audiobook-page-title">
          <h1>{person ? `Photos of ${person.name}` : "Photos"}</h1>
          {total > 0 && <p className="ft-tree-count">{total} {total === 1 ? "photo" : "photos"}</p>}
        </div>

        {error && <MessageBox tone="error" title="Unable to load photos">{error}</MessageBox>}

        {!loading && photos.length === 0 ? (
          <div className="ft-empty-panel">
            <ImagePlus size={22} aria-hidden="true" />
            <strong>No photos yet</strong>
          </div>
        ) : (
          <div className="gallery-grid ft-photo-grid">
            {photos.map((photo, index) => (
              <button
                key={photo.id}
                type="button"
                className="gallery-tile"
                onClick={() => setLightboxIndex(index)}
                title={photo.title}
              >
                {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" style={faceFocusStyle(photo)} />}
                {photo.kind === "video" && (
                  <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
                )}
              </button>
            ))}
          </div>
        )}

        {photos.length < total && (
          <div className="ft-photos-page-more">
            <Button
              variant="secondary"
              onClick={() => {
                setLoadingMore(true);
                loadPhotos(photos.length).catch(() => {}).finally(() => setLoadingMore(false));
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : `Show more (${total - photos.length} left)`}
            </Button>
          </div>
        )}
      </section>

      {lightboxIndex != null && photos[lightboxIndex] && (
        <GalleryLightbox
          assets={photos}
          index={lightboxIndex}
          canDelete={false}
          canEdit={false}
          canShare={false}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          onChanged={() => { void loadPhotos(0); }}
        />
      )}
    </DashboardShell>
  );
}
