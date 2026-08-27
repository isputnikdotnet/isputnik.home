import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Film, Image as ImageIcon, Type } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { MessageBox } from "../../shared/MessageBox";
import { PhotoPicker } from "./PhotoPicker";
import type {
  GalleryAsset, GalleryLibrary, GallerySlideshowDetail, SlideshowPatch, SlideshowCardFont, SlideshowCardSize,
  SlideshowSubtitleMode, SlideshowTitleBackground
} from "./types";
import { faceFocusStyle } from "./types";

// A clip's length as the row shows it — "1:23" past a minute, "45s" under one.
function clipLength(seconds: number | null): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.max(1, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type CardTab = "opening" | "closing";

/**
 * The movie's opening title card and closing credits card, edited side by side with
 * the picture they produce. One dialog, two tabs — Opening and Closing — over the
 * same body: the preview and the card's own text on the left, the settings on the
 * right. Every change is saved as it is made and the preview is redrawn by the SAME
 * code the render uses, so what you see is the movie's actual first (or last)
 * seconds. Font style and text size are shared by both cards — one typographic
 * voice per movie.
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
  const { t } = useTranslation(["common", "galleryModals"]);
  // Built fresh on every render (not module-level consts) so they stay reactive to a
  // language switch — see the i18n plan's namespace-key typing pitfalls.
  const BACKGROUNDS: { value: SlideshowTitleBackground; label: string; hint: string }[] = [
    { value: "black", label: t("galleryModals:titleCard.bg.black.label"), hint: t("galleryModals:titleCard.bg.black.hint") },
    { value: "photo", label: t("galleryModals:titleCard.bg.photo.label"), hint: t("galleryModals:titleCard.bg.photo.hint") },
    { value: "blur", label: t("galleryModals:titleCard.bg.blur.label"), hint: t("galleryModals:titleCard.bg.blur.hint") },
    { value: "collage", label: t("galleryModals:titleCard.bg.collage.label"), hint: t("galleryModals:titleCard.bg.collage.hint") }
  ];
  const SUBTITLES: { value: SlideshowSubtitleMode; label: string }[] = [
    { value: "count", label: t("galleryModals:titleCard.subtitleCount") },
    { value: "custom", label: t("galleryModals:titleCard.subtitleCustom") },
    { value: "none", label: t("galleryModals:titleCard.subtitleNone") }
  ];
  // Each chip is drawn in its own face (the @font-face set in gallery.css, copies of
  // the very files the server renders with), so picking a style is never blind — and
  // the preview above redraws through the render code as the final word.
  const FONTS: { value: SlideshowCardFont; label: string; hint: string }[] = [
    { value: "classic", label: t("galleryModals:titleCard.font.classic.label"), hint: t("galleryModals:titleCard.font.classic.hint") },
    { value: "serif", label: t("galleryModals:titleCard.font.serif.label"), hint: t("galleryModals:titleCard.font.serif.hint") },
    { value: "bold", label: t("galleryModals:titleCard.font.bold.label"), hint: t("galleryModals:titleCard.font.bold.hint") },
    { value: "script", label: t("galleryModals:titleCard.font.script.label"), hint: t("galleryModals:titleCard.font.script.hint") },
    { value: "typewriter", label: t("galleryModals:titleCard.font.typewriter.label"), hint: t("galleryModals:titleCard.font.typewriter.hint") }
  ];
  const SIZES: { value: SlideshowCardSize; label: string }[] = [
    { value: "small", label: t("galleryModals:titleCard.size.small") },
    { value: "medium", label: t("galleryModals:titleCard.size.medium") },
    { value: "large", label: t("galleryModals:titleCard.size.large") }
  ];
  const [card, setCard] = useState<CardTab>("opening");
  const [clipPickerOpen, setClipPickerOpen] = useState(false);
  // The text fields are local until they lose focus: a PATCH per keystroke would be a
  // request per letter, and a preview redrawn mid-word.
  const [titleText, setTitleText] = useState(slideshow.titleText ?? "");
  const [subtitle, setSubtitle] = useState(slideshow.titleSubtitle ?? "");
  const [closingText, setClosingText] = useState(slideshow.closingText ?? "");
  const [closingLines, setClosingLines] = useState(slideshow.closingLines ?? "");
  const [seconds, setSeconds] = useState(slideshow.titleSeconds);
  const [closingSeconds, setClosingSeconds] = useState(slideshow.closingSeconds);
  // Bumped after every saved change so the browser fetches a fresh card rather than
  // the one it already has for this URL.
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setSeconds(slideshow.titleSeconds); }, [slideshow.titleSeconds]);
  useEffect(() => { setClosingSeconds(slideshow.closingSeconds); }, [slideshow.closingSeconds]);

  const commit = async (fields: SlideshowPatch) => {
    setSaving(true);
    setError("");
    try {
      await onPatch(fields);
      setPreviewFailed(false);
      setLoadingPreview(true);
      setVersion((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:titleCard.unableToSave"));
    } finally {
      setSaving(false);
    }
  };

  const opening = card === "opening";
  const enabled = opening ? slideshow.titleEnabled : slideshow.closingEnabled;
  const clip = opening ? slideshow.introClip : slideshow.outroClip;
  const photos = assets.filter((asset) => asset.kind === "photo");
  const background = opening ? slideshow.titleBackground : slideshow.closingBackground;
  const photoItemId = opening ? slideshow.titlePhotoItemId : slideshow.closingPhotoItemId;
  const usesPhoto = background === "photo" || background === "blur";
  // A background photo that was never chosen means the first slide, which is what the
  // render does — so the strip shows that one as selected rather than nothing.
  const selectedPhotoId = photoItemId ?? photos[0]?.id ?? null;
  const previewUrl = `/api/library/gallery/slideshows/${slideshow.id}/title-card.png?${opening ? "" : "card=closing&"}v=${version}`;

  const switchCard = (next: CardTab) => {
    if (next === card) return;
    setCard(next);
    setPreviewFailed(false);
    setLoadingPreview(true);
  };

  return (
    <Modal
      variant="panel"
      title={t("galleryModals:titleCard.title")}
      subtitle={t("galleryModals:titleCard.subtitle")}
      icon={<Type size={20} />}
      className="slideshow-title-modal"
      onClose={onClose}
    >
      {/* Two panes: the preview (with the card's own text and its enable toggle)
          fixed on the left while the settings scroll on the right — every change is
          judged against the picture it produces, so the picture must never scroll
          away. With the card switched off there are no settings, and the stage sits
          alone, centred. */}
      <div className={`modal-tab-content slideshow-title-body${enabled ? "" : " is-disabled"}`}>
        <div className="slideshow-title-tabs" role="tablist" aria-label={t("galleryModals:titleCard.tabsAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={opening}
            className={opening ? "is-on" : ""}
            onClick={() => switchCard("opening")}
          >
            {t("galleryModals:titleCard.tabOpening")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!opening}
            className={opening ? "" : "is-on"}
            onClick={() => switchCard("closing")}
          >
            {t("galleryModals:titleCard.tabClosing")}
          </button>
        </div>

        {error && (
          <div className="slideshow-title-error">
            <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>
          </div>
        )}

        <div className="slideshow-title-stage">
          <div className="slideshow-title-preview">
            {enabled ? (
              previewFailed ? (
                <p className="management-empty">{t("galleryModals:titleCard.previewFailed")}</p>
              ) : (
                <img
                  key={`${card}-${version}`}
                  src={previewUrl}
                  alt={opening ? t("galleryModals:titleCard.previewAltOpening") : t("galleryModals:titleCard.previewAltClosing")}
                  className={loadingPreview || saving ? "is-loading" : ""}
                  onLoad={() => setLoadingPreview(false)}
                  onError={() => { setLoadingPreview(false); setPreviewFailed(true); }}
                />
              )
            ) : (
              <p className="management-empty">
                {opening
                  ? t("galleryModals:titleCard.disabledOpening")
                  : t("galleryModals:titleCard.disabledClosing")}
              </p>
            )}
          </div>

          {/* What the card says lives with the picture that shows it: type here, see
              it drawn above on the next save. */}
          {enabled && (opening ? (
            <div className="slideshow-title-field" key="opening-title">
              <label htmlFor="slideshow-title-text">{t("galleryModals:titleCard.titleFieldLabel")}</label>
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
              <small className="muted">{t("galleryModals:titleCard.titleEmptyHint")}</small>
            </div>
          ) : (
            <div className="slideshow-title-field" key="closing-title">
              <label htmlFor="slideshow-closing-text">{t("galleryModals:titleCard.endTitleFieldLabel")}</label>
              <input
                id="slideshow-closing-text"
                type="text"
                maxLength={120}
                value={closingText}
                placeholder={t("galleryModals:titleCard.theEndPlaceholder")}
                onChange={(event) => setClosingText(event.target.value)}
                onBlur={() => {
                  const next = closingText.trim();
                  if (next !== (slideshow.closingText ?? "")) void commit({ closingText: next || null });
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
              <small className="muted">{t("galleryModals:titleCard.closingEmptyHint")}</small>
            </div>
          ))}

          <div className="slideshow-title-row">
            <ToggleSwitch
              checked={enabled}
              disabled={saving}
              onChange={(next) => void commit(opening ? { titleEnabled: next } : { closingEnabled: next })}
              ariaLabel={opening ? t("galleryModals:titleCard.openToggleAria") : t("galleryModals:titleCard.closeToggleAria")}
            />
            <span>
              {opening ? t("galleryModals:titleCard.openToggleAria") : t("galleryModals:titleCard.closeToggleAria")}
              <small>
                {opening
                  ? t("galleryModals:titleCard.openCrossfadeHint")
                  : t("galleryModals:titleCard.closeSilenceHint")}
              </small>
            </span>
          </div>

          {/* The clip is independent of the card — it plays whether or not the card
              is on, so it lives outside the enabled-only settings. */}
          <div className="slideshow-title-field">
            <span className="slideshow-setting-label">{opening ? t("galleryModals:titleCard.openingClipLabel") : t("galleryModals:titleCard.closingClipLabel")}</span>
            {clip ? (
              <>
                <div className="slideshow-clip-row">
                  <span className="slideshow-clip-thumb">
                    {clip.coverUrl
                      ? <img src={clip.coverUrl} alt="" loading="lazy" />
                      : <Film size={18} aria-hidden="true" />}
                  </span>
                  <span className="slideshow-clip-name">
                    {clip.title}
                    {clipLength(clip.durationSeconds) && <small>{clipLength(clip.durationSeconds)}</small>}
                  </span>
                  <Button variant="text" disabled={saving} onClick={() => setClipPickerOpen(true)}>{t("galleryModals:titleCard.change")}</Button>
                  <Button
                    variant="text"
                    disabled={saving}
                    onClick={() => void commit(opening ? { introItemId: null } : { outroItemId: null })}
                  >
                    {t("galleryModals:titleCard.remove")}
                  </Button>
                </div>
                <div className="slideshow-title-row slideshow-clip-sound">
                  <ToggleSwitch
                    checked={opening ? slideshow.introSound : slideshow.outroSound}
                    disabled={saving}
                    onChange={(next) => void commit(opening ? { introSound: next } : { outroSound: next })}
                    ariaLabel={t("galleryModals:titleCard.useClipSoundAria")}
                  />
                  <span>
                    {t("galleryModals:titleCard.useClipSoundAria")}
                    <small>{t("galleryModals:titleCard.clipSoundHint")}</small>
                  </span>
                </div>
              </>
            ) : (
              <div>
                <Button variant="secondary" disabled={saving} onClick={() => setClipPickerOpen(true)}>
                  <Film size={15} aria-hidden="true" /> {t("galleryModals:titleCard.chooseVideo")}
                </Button>
              </div>
            )}
            <small className="muted">
              {opening
                ? t("galleryModals:titleCard.openingClipHint")
                : t("galleryModals:titleCard.closingClipHint")}
            </small>
          </div>
        </div>

        {enabled && (
          <div className="slideshow-title-fields">
            {opening ? (
              <div className="slideshow-title-field">
                <span className="slideshow-setting-label">{t("galleryModals:titleCard.secondLineLabel")}</span>
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
                  <>
                    <textarea
                      rows={3}
                      maxLength={500}
                      value={subtitle}
                      placeholder={t("galleryModals:titleCard.subtitlePlaceholder")}
                      aria-label={t("galleryModals:titleCard.customLinesAria")}
                      onChange={(event) => setSubtitle(event.target.value)}
                      onBlur={() => {
                        const next = subtitle.trim();
                        if (next !== (slideshow.titleSubtitle ?? "")) void commit({ titleSubtitle: next || null });
                      }}
                    />
                    <small className="muted">{t("galleryModals:titleCard.sixLinesHint")}</small>
                  </>
                )}
              </div>
            ) : (
              <div className="slideshow-title-field">
                <label className="slideshow-setting-label" htmlFor="slideshow-closing-lines">{t("galleryModals:titleCard.creditsLabel")}</label>
                <textarea
                  id="slideshow-closing-lines"
                  rows={4}
                  maxLength={500}
                  value={closingLines}
                  placeholder={t("galleryModals:titleCard.creditsPlaceholder")}
                  onChange={(event) => setClosingLines(event.target.value)}
                  onBlur={() => {
                    const next = closingLines.trim();
                    if (next !== (slideshow.closingLines ?? "")) void commit({ closingLines: next || null });
                  }}
                />
                <small className="muted">{t("galleryModals:titleCard.sixLinesHintClosing")}</small>
              </div>
            )}

            <div className="slideshow-title-field">
              <span className="slideshow-setting-label">{t("galleryModals:titleCard.fontStyleLabel")}</span>
              <div className="slideshow-transitions">
                {FONTS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`slideshow-card-font is-${option.value}${slideshow.cardFont === option.value ? " is-on" : ""}`}
                    aria-pressed={slideshow.cardFont === option.value}
                    disabled={saving}
                    onClick={() => {
                      if (slideshow.cardFont !== option.value) void commit({ cardFont: option.value });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small className="muted">
                {FONTS.find((option) => option.value === slideshow.cardFont)?.hint}{t("galleryModals:titleCard.fontHintSuffix")}
              </small>
            </div>

            <div className="slideshow-title-field">
              <span className="slideshow-setting-label">{t("galleryModals:titleCard.textSizeLabel")}</span>
              <div className="slideshow-transitions">
                {SIZES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={slideshow.cardSize === option.value ? "is-on" : ""}
                    aria-pressed={slideshow.cardSize === option.value}
                    disabled={saving}
                    onClick={() => {
                      if (slideshow.cardSize !== option.value) void commit({ cardSize: option.value });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small className="muted">{t("galleryModals:titleCard.sizeHint")}</small>
            </div>

            <div className="slideshow-title-field">
              <label className="slideshow-setting-label" htmlFor="slideshow-card-seconds">{t("galleryModals:titleCard.onScreenForLabel")}</label>
              <div className="slideshow-dwell">
                <input
                  id="slideshow-card-seconds"
                  type="range"
                  min={1}
                  max={opening ? 10 : 15}
                  step={1}
                  value={opening ? seconds : closingSeconds}
                  disabled={saving}
                  onChange={(event) => (opening ? setSeconds : setClosingSeconds)(Number(event.target.value))}
                  onPointerUp={() => {
                    if (opening && seconds !== slideshow.titleSeconds) void commit({ titleSeconds: seconds });
                    if (!opening && closingSeconds !== slideshow.closingSeconds) void commit({ closingSeconds });
                  }}
                  onKeyUp={() => {
                    if (opening && seconds !== slideshow.titleSeconds) void commit({ titleSeconds: seconds });
                    if (!opening && closingSeconds !== slideshow.closingSeconds) void commit({ closingSeconds });
                  }}
                />
                <span className="slideshow-dwell-value">{opening ? seconds : closingSeconds}s</span>
              </div>
              {!opening && <small className="muted">{t("galleryModals:titleCard.closingFadeHint")}</small>}
            </div>

            <div className="slideshow-title-field">
              <span className="slideshow-setting-label">{t("galleryModals:titleCard.backgroundLabel")}</span>
              <div className="slideshow-transitions">
                {BACKGROUNDS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={background === option.value ? "is-on" : ""}
                    aria-pressed={background === option.value}
                    disabled={saving}
                    onClick={() => {
                      if (background !== option.value) {
                        void commit(opening ? { titleBackground: option.value } : { closingBackground: option.value });
                      }
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <small className="muted">
                {BACKGROUNDS.find((option) => option.value === background)?.hint}
              </small>
            </div>

            {usesPhoto && (
              photos.length === 0 ? (
                <MessageBox tone="info" title={t("galleryModals:titleCard.noPhotoTitle")}>
                  {t("galleryModals:titleCard.noPhotoBody")}
                </MessageBox>
              ) : (
                <div className="slideshow-title-field">
                  <span className="slideshow-setting-label">{t("galleryModals:titleCard.whichPhotoLabel")}</span>
                  <div className="slideshow-title-photos">
                    {photos.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        className={`slideshow-title-photo${photo.id === selectedPhotoId ? " is-selected" : ""}`}
                        aria-pressed={photo.id === selectedPhotoId}
                        disabled={saving}
                        title={photo.title}
                        aria-label={t("galleryModals:titleCard.usePhotoAria", { title: photo.title })}
                        onClick={() => {
                          if (photo.id !== photoItemId) {
                            void commit(opening ? { titlePhotoItemId: photo.id } : { closingPhotoItemId: photo.id });
                          }
                        }}
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
          </div>
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
      </div>

      {clipPickerOpen && (
        <PhotoPicker
          title={opening ? t("galleryModals:titleCard.pickOpeningClip") : t("galleryModals:titleCard.pickClosingClip")}
          pick="video"
          onPick={(asset) => {
            setClipPickerOpen(false);
            void commit(opening ? { introItemId: asset.id } : { outroItemId: asset.id });
          }}
          onClose={() => setClipPickerOpen(false)}
        />
      )}
    </Modal>
  );
}
