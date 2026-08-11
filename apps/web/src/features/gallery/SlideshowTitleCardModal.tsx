import { useEffect, useState } from "react";
import { Image as ImageIcon, Type } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { MessageBox } from "../../shared/MessageBox";
import type {
  GalleryAsset, GallerySlideshowDetail, SlideshowPatch, SlideshowSubtitleMode, SlideshowTitleBackground
} from "./types";
import { faceFocusStyle } from "./types";

const BACKGROUNDS: { value: SlideshowTitleBackground; label: string; hint: string }[] = [
  { value: "black", label: "Black", hint: "White text on a plain black frame." },
  { value: "photo", label: "A photo", hint: "One slide fills the frame, darkened behind the words." },
  { value: "blur", label: "Blurred photo", hint: "The same slide, blurred — colour and mood without a competing subject." },
  { value: "collage", label: "Collage", hint: "A grid tiled from photos spread across the whole slideshow." }
];

const SUBTITLES: { value: SlideshowSubtitleMode; label: string }[] = [
  { value: "count", label: "Photo count" },
  { value: "custom", label: "My own line" },
  { value: "none", label: "Nothing" }
];

/**
 * The movie's opening title card: what it says, how long it holds, and what the words
 * sit on. Every change is saved as it is made and the preview above is redrawn by the
 * SAME code the render uses — choosing a background over a photo nobody has seen is
 * guesswork, and this is a picture of the actual first three seconds.
 *
 * The background can only be the slideshow's own photos: videos would have to be
 * decoded to yield a frame, so they are left out of the picker and a slideshow of
 * nothing but videos falls back to the black card.
 */
export function SlideshowTitleCardModal({
  slideshow,
  assets,
  onPatch,
  onClose
}: {
  slideshow: GallerySlideshowDetail;
  assets: GalleryAsset[];
  onPatch: (fields: SlideshowPatch) => Promise<void> | void;
  onClose: () => void;
}) {
  // The text fields are local until they lose focus: a PATCH per keystroke would be a
  // request per letter, and a preview redrawn mid-word.
  const [titleText, setTitleText] = useState(slideshow.titleText ?? "");
  const [subtitle, setSubtitle] = useState(slideshow.titleSubtitle ?? "");
  const [seconds, setSeconds] = useState(slideshow.titleSeconds);
  // Bumped after every saved change so the browser fetches a fresh card rather than
  // the one it already has for this URL.
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setSeconds(slideshow.titleSeconds); }, [slideshow.titleSeconds]);

  const commit = async (fields: SlideshowPatch) => {
    setSaving(true);
    setError("");
    try {
      await onPatch(fields);
      setPreviewFailed(false);
      setLoadingPreview(true);
      setVersion((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the title card");
    } finally {
      setSaving(false);
    }
  };

  const photos = assets.filter((asset) => asset.kind === "photo");
  const usesPhoto = slideshow.titleBackground === "photo" || slideshow.titleBackground === "blur";
  // A background photo that was never chosen means the first slide, which is what the
  // render does — so the strip shows that one as selected rather than nothing.
  const selectedPhotoId = slideshow.titlePhotoItemId ?? photos[0]?.id ?? null;
  const previewUrl = `/api/library/gallery/slideshows/${slideshow.id}/title-card.png?v=${version}`;

  return (
    <Modal
      variant="panel"
      title="Title card"
      subtitle="The opening seconds of the rendered movie."
      icon={<Type size={20} />}
      className="slideshow-title-modal"
      onClose={onClose}
    >
      <div className="modal-tab-content slideshow-title-body">
        {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

        <div className="slideshow-title-preview">
          {slideshow.titleEnabled ? (
            previewFailed ? (
              <p className="management-empty">The preview couldn’t be drawn. The movie will still render.</p>
            ) : (
              <img
                key={version}
                src={previewUrl}
                alt="Preview of the movie’s title card"
                className={loadingPreview || saving ? "is-loading" : ""}
                onLoad={() => setLoadingPreview(false)}
                onError={() => { setLoadingPreview(false); setPreviewFailed(true); }}
              />
            )
          ) : (
            <p className="management-empty">No title card — the movie opens straight on the first photo.</p>
          )}
        </div>

        <div className="slideshow-title-row">
          <ToggleSwitch
            checked={slideshow.titleEnabled}
            disabled={saving}
            onChange={(enabled) => void commit({ titleEnabled: enabled })}
            ariaLabel="Open the movie with a title card"
          />
          <span>
            Open the movie with a title card
            <small>It cross-fades into the first photo with the slideshow’s own transition.</small>
          </span>
        </div>

        {slideshow.titleEnabled && (
          <>
            <div className="slideshow-title-field">
              <label htmlFor="slideshow-title-text">Title</label>
              <input
                id="slideshow-title-text"
                type="text"
                maxLength={120}
                value={titleText}
                placeholder={slideshow.name}
                onChange={(event) => setTitleText(event.target.value)}
                onBlur={() => {
                  const next = titleText.trim();
                  if (next !== (slideshow.titleText ?? "")) void commit({ titleText: next || null });
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <small className="muted">Leave it empty to use the slideshow’s name.</small>
            </div>

            <div className="slideshow-title-field">
              <span className="slideshow-setting-label">Second line</span>
              <div className="slideshow-transitions">
                {SUBTITLES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={slideshow.titleSubtitleMode === option.value ? "is-on" : ""}
                    aria-pressed={slideshow.titleSubtitleMode === option.value}
                    disabled={saving}
                    onClick={() => {
                      if (slideshow.titleSubtitleMode !== option.value) void commit({ titleSubtitleMode: option.value });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {slideshow.titleSubtitleMode === "custom" && (
                <input
                  type="text"
                  maxLength={120}
                  value={subtitle}
                  placeholder="Summer 2026 · Sicily"
                  aria-label="Second line of the title card"
                  onChange={(event) => setSubtitle(event.target.value)}
                  onBlur={() => {
                    const next = subtitle.trim();
                    if (next !== (slideshow.titleSubtitle ?? "")) void commit({ titleSubtitle: next || null });
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                />
              )}
            </div>

            <div className="slideshow-title-field">
              <label className="slideshow-setting-label" htmlFor="slideshow-title-seconds">On screen for</label>
              <div className="slideshow-dwell">
                <input
                  id="slideshow-title-seconds"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={seconds}
                  disabled={saving}
                  onChange={(event) => setSeconds(Number(event.target.value))}
                  onPointerUp={() => { if (seconds !== slideshow.titleSeconds) void commit({ titleSeconds: seconds }); }}
                  onKeyUp={() => { if (seconds !== slideshow.titleSeconds) void commit({ titleSeconds: seconds }); }}
                />
                <span className="slideshow-dwell-value">{seconds}s</span>
              </div>
            </div>

            <div className="slideshow-title-field">
              <span className="slideshow-setting-label">Background</span>
              <div className="slideshow-transitions">
                {BACKGROUNDS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={slideshow.titleBackground === option.value ? "is-on" : ""}
                    aria-pressed={slideshow.titleBackground === option.value}
                    disabled={saving}
                    onClick={() => {
                      if (slideshow.titleBackground !== option.value) void commit({ titleBackground: option.value });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small className="muted">
                {BACKGROUNDS.find((option) => option.value === slideshow.titleBackground)?.hint}
              </small>
            </div>

            {usesPhoto && (
              photos.length === 0 ? (
                <MessageBox tone="info" title="No photo to use">
                  This slideshow has only videos, and a video can’t be used as a background. The card
                  will be drawn on black until you add a photo.
                </MessageBox>
              ) : (
                <div className="slideshow-title-field">
                  <span className="slideshow-setting-label">Which photo</span>
                  <div className="slideshow-title-photos">
                    {photos.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        className={`slideshow-title-photo${photo.id === selectedPhotoId ? " is-selected" : ""}`}
                        aria-pressed={photo.id === selectedPhotoId}
                        disabled={saving}
                        title={photo.title}
                        aria-label={`Use ${photo.title} as the title-card background`}
                        onClick={() => { if (photo.id !== slideshow.titlePhotoItemId) void commit({ titlePhotoItemId: photo.id }); }}
                      >
                        {photo.coverUrl
                          ? <img src={photo.coverUrl} alt="" loading="lazy" style={faceFocusStyle(photo)} />
                          : <span className="gallery-tile-fallback"><ImageIcon size={20} aria-hidden="true" /></span>}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
          </>
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
