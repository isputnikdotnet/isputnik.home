import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookText, BriefcaseBusiness, CalendarDays, CheckCircle2, Eye, Heart, Image as ImageIcon, Library, MapPin, Star, type LucideIcon } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { PartialDateField } from "../../shared/PartialDateField";
import { PhotoPicker } from "../gallery/PhotoPicker";
import type { GalleryAsset } from "../gallery/types";
import { StoryRefPicker } from "./StoryRefPicker";
import { STORY_KINDS, type StoryKind } from "./types";

const STORY_KIND_ICONS: Record<StoryKind, LucideIcon> = {
  free: BookText,
  memory: Heart,
  journal: BriefcaseBusiness,
  review: Star
};

// A new story opens straight into its editor — there is nothing to look at
// until something is written. The kind is a TEMPLATE choice made here and
// only here, and the modal's fields follow it: a memory asks when and where,
// a travel blog asks from–to (a full range lays out one chapter per day), a
// review asks which book. Everything is skippable, everything it seeds is an
// ordinary field afterwards, and the kind gates nothing.
//
// Opened from a collection page it is the same form with the shelf already
// chosen — a story born on a shelf deserves the same start as one born on the
// index, so the collection is a prop here, never a field to fill in again.
export function NewStoryModal({
  collectionId,
  collectionTitle,
  onClose
}: {
  /** Present = the story is born onto that shelf. */
  collectionId?: string;
  /** Names the shelf in the modal's subtitle. */
  collectionTitle?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [kind, setKind] = useState<StoryKind>("free");
  const [date, setDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [place, setPlace] = useState("");
  const [book, setBook] = useState<{ id: string; entityType: "audiobook" | "ebook"; title: string } | null>(null);
  const [pickingBook, setPickingBook] = useState(false);
  const [cover, setCover] = useState<GalleryAsset | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const previewTitle = title.trim() || (kind === "review" ? book?.title.trim() : "") || t("stories:fields.titlePlaceholder");
  const previewSubtitle = subtitle.trim() || t("stories:fields.subtitlePlaceholder");
  const previewDate = kind === "journal"
    ? formatPartialDateRange(date.trim(), endDate.trim() || null)
    : kind !== "review"
      ? formatPartialDateRange(date.trim(), null)
      : "";
  const previewPlace = kind === "memory" ? place.trim() : "";

  const submit = async () => {
    // A review with a chosen book can go out untitled — the book names it.
    const trimmed = title.trim() || (kind === "review" ? book?.title ?? "" : "");
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { story } = await api<{ story: { id: string } }>("/api/stories", {
        method: "POST",
        body: JSON.stringify({
          title: trimmed,
          subtitle: subtitle.trim() || null,
          kind,
          date: kind !== "review" && date.trim() ? date.trim() : null,
          endDate: kind === "journal" && endDate.trim() ? endDate.trim() : null,
          place: kind === "memory" && place.trim() ? place.trim() : null,
          reviewOf: kind === "review" && book ? { entityType: book.entityType, entityId: book.id } : null,
          collectionId: collectionId ?? null
        })
      });
      // Same follow-up-PATCH shape as the collection modal: creation takes no
      // cover, and a failure here shouldn't strand an otherwise-successful
      // create — the cover stays settable from the editor afterwards.
      if (cover) {
        await api(`/api/stories/${story.id}`, {
          method: "PATCH",
          body: JSON.stringify({ coverItemId: cover.id })
        }).catch(() => {});
      }
      navigate(`/stories/${story.id}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.create"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("stories:newStory")}
      subtitle={collectionTitle
        ? t("stories:create.introInCollection", { name: collectionTitle })
        : t("stories:create.intro")}
      icon={<BookText size={24} />}
      className="story-new-story-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <div className="modal-tab-content story-new-story-content">
        {error && <MessageBox tone="error" title={t("stories:errors.createTitle")}>{error}</MessageBox>}

        <div className="story-new-story-layout">
          <div className="story-new-story-fields">
            <div className="story-kind-row" role="radiogroup" aria-label={t("stories:kinds.label")}>
              {STORY_KINDS.map((option) => {
                const KindIcon = STORY_KIND_ICONS[option];
                return (
                  <Button
                    key={option}
                    variant="secondary"
                    className={`story-kind-option${kind === option ? " is-current" : ""}`}
                    role="radio"
                    aria-checked={kind === option}
                    onClick={() => setKind(option)}
                  >
                    <span className="story-kind-option-icon">
                      <KindIcon size={19} aria-hidden="true" />
                      {kind === option && <CheckCircle2 size={17} className="story-kind-check" aria-hidden="true" />}
                    </span>
                    <strong>{t(`stories:kinds.${option}.name`)}</strong>
                    <small>{t(`stories:kinds.${option}.hint`)}</small>
                  </Button>
                );
              })}
            </div>

            <label className="field story-new-story-field">
              <span>{t("stories:fields.title")}</span>
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("stories:fields.titlePlaceholder")}
                maxLength={160}
              />
            </label>

            <label className="field story-new-story-field">
              <span>{t("stories:fields.subtitle")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <input
                value={subtitle}
                onChange={(event) => setSubtitle(event.target.value)}
                placeholder={t("stories:fields.subtitlePlaceholder")}
                maxLength={300}
              />
            </label>

            {(kind === "memory" || kind === "free") && (
              <div className="story-create-row story-new-story-date-row">
                <PartialDateField
                  className="story-new-story-field"
                  label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                  value={date}
                  onChange={setDate}
                  placeholder={t("stories:chapter.datePlaceholder")}
                />
                {kind === "memory" && (
                  <label className="field story-new-story-field">
                    <span>{t("stories:chapter.placeField")} <small className="muted">{t("stories:fields.optional")}</small></span>
                    <input
                      value={place}
                      onChange={(event) => setPlace(event.target.value)}
                      placeholder={t("stories:chapter.placePlaceholder")}
                      maxLength={200}
                    />
                  </label>
                )}
              </div>
            )}

            {kind === "journal" && (
              <>
                <div className="story-create-row story-new-story-date-row">
                  <PartialDateField
                    className="story-new-story-field"
                    label={`${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                    value={date}
                    onChange={setDate}
                    placeholder={t("stories:chapter.datePlaceholder")}
                  />
                  <PartialDateField
                    className="story-new-story-field"
                    label={t("stories:chapter.endDateField")}
                    value={endDate}
                    onChange={setEndDate}
                    placeholder={t("stories:chapter.endDatePlaceholder")}
                  />
                </div>
                <p className="muted story-create-hint">{t("stories:create.journalRangeHint")}</p>
              </>
            )}

            {kind === "review" && (
              <div className="story-create-row story-create-book">
                <Button variant="secondary" compact onClick={() => setPickingBook(true)} disabled={saving}>
                  <BookText size={15} aria-hidden="true" />
                  <span>{book ? t("stories:create.changeBook") : t("stories:create.pickBook")}</span>
                </Button>
                {book && <span className="story-create-book-title">{book.title}</span>}
              </div>
            )}
          </div>

          <aside className="story-new-story-preview-panel" aria-label={t("stories:actions.preview")}>
            <h3>
              <Eye size={20} aria-hidden="true" />
              <span>{t("stories:actions.preview")}</span>
            </h3>

            <div className="story-new-story-preview-card">
              {/* The same fanned photos New collection shows — one placeholder
                  for "a cover goes here", not two different ones. */}
              <div className="story-preview-covers" aria-hidden="true">
                {cover?.coverUrl ? (
                  <img src={cover.coverUrl} alt="" />
                ) : (
                  <>
                    <span className="story-preview-photo is-back-left" />
                    <span className="story-preview-photo is-back-right" />
                    <span className="story-preview-photo is-main" />
                    <span className="story-preview-photo is-side" />
                  </>
                )}
              </div>
              <div className="story-new-story-preview-body">
                <strong>{previewTitle}</strong>
                <p>{previewSubtitle}</p>
                {(previewDate || previewPlace) && (
                  <div className="story-new-story-preview-meta">
                    {previewDate && (
                      <span>
                        <CalendarDays size={15} aria-hidden="true" />
                        {previewDate}
                      </span>
                    )}
                    {previewPlace && (
                      <span>
                        <MapPin size={15} aria-hidden="true" />
                        {previewPlace}
                      </span>
                    )}
                  </div>
                )}
                <div className="story-new-story-preview-chips">
                  <span>
                    <Library size={15} aria-hidden="true" />
                    {t(`stories:kinds.${kind}.name`)}
                  </span>
                  {kind === "review" && book && (
                    <span>
                      <BookText size={15} aria-hidden="true" />
                      {book.title}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="story-cover-field">
              <span>
                {t("stories:create.coverImage")} <small className="muted">{t("stories:fields.optional")}</small>
              </span>
              {cover ? (
                <div className="story-chapter-hero-row">
                  <img className="story-chapter-hero-thumb" src={cover.coverUrl ?? undefined} alt="" />
                  <Button variant="secondary" compact onClick={() => setPickingCover(true)} disabled={saving}>
                    {t("stories:fields.changeCover")}
                  </Button>
                  <Button variant="text" compact onClick={() => setCover(null)} disabled={saving}>
                    {t("stories:fields.clearCover")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="story-cover-picker-button"
                  onClick={() => setPickingCover(true)}
                  disabled={saving}
                >
                  <ImageIcon size={20} aria-hidden="true" />
                  <span>{t("stories:fields.setCover")}</span>
                </Button>
              )}
            </div>
          </aside>
        </div>

        <div className="modal-actions story-new-story-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving || (!title.trim() && !(kind === "review" && book))}
          >
            {saving ? t("stories:actions.creating") : t("stories:actions.create")}
          </Button>
        </div>
      </div>

      {pickingBook && (
        <StoryRefPicker
          kind="book"
          onPick={(id, entityType, bookTitle) => {
            setPickingBook(false);
            if (!entityType) return;
            setBook({ id, entityType, title: bookTitle ?? "" });
          }}
          onClose={() => setPickingBook(false)}
        />
      )}

      {pickingCover && (
        <PhotoPicker
          title={t("stories:fields.coverPickerTitle")}
          pick="any"
          onPick={(asset) => { setPickingCover(false); setCover(asset); }}
          onClose={() => setPickingCover(false)}
        />
      )}
    </Modal>
  );
}
