import { useState } from "react";
import { BookOpen, BookText, BriefcaseBusiness, CheckCircle2, Heart, MapPin, Star, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { navigate } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { PartialDateField } from "../../shared/PartialDateField";
import type { ActionMenuItem } from "../../shared/ActionMenu";
import { StoryCoverBanner } from "./StoryCoverBanner";
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
// only here, and the card below the page follows it: a memory asks when and
// where, a travel blog asks from–to (a full range lays out one chapter per
// day), a review asks which book. Everything is skippable, everything it seeds
// is an ordinary field afterwards, and the kind gates nothing.
//
// The modal is shaped like the editor it hands you over to: the story's front
// page, with its cover band, its name and its subtitle set where they will be
// read, over one settings card holding what the words can't say. There is no
// separate preview pane — a preview beside the fields was a second, smaller
// rendering of the same thing, and the page itself is the honest one.
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
  const [book, setBook] = useState<
    { id: string; entityType: "audiobook" | "ebook"; title: string; coverUrl: string | null } | null
  >(null);
  const [pickingBook, setPickingBook] = useState(false);
  // The chosen cover as the band needs it: what to draw, and which library item
  // to point the story at. A review can point at its own book.
  const [cover, setCover] = useState<{ id: string; url: string | null } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // The dateline the story's front page will carry, as it is being decided.
  const previewDate = kind === "journal"
    ? formatPartialDateRange(date.trim(), endDate.trim() || null)
    : kind !== "review"
      ? formatPartialDateRange(date.trim(), null)
      : "";
  const previewPlace = kind === "memory" ? place.trim() : "";
  const KindIcon = STORY_KIND_ICONS[kind];

  // A review is about a book, and a book already has a face — offer it rather
  // than making someone go looking for a photograph of one.
  const bookCover: ActionMenuItem[] = kind === "review" && book?.coverUrl
    ? [{
      key: "book",
      label: t("stories:edit.coverUseBook"),
      icon: <BookOpen size={15} aria-hidden="true" />,
      onSelect: () => setCover({ id: book.id, url: book.coverUrl })
    }]
    : [];

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

        <div className="story-kind-row" role="radiogroup" aria-label={t("stories:kinds.label")}>
          {STORY_KINDS.map((option) => {
            const OptionIcon = STORY_KIND_ICONS[option];
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
                  <OptionIcon size={19} aria-hidden="true" />
                  {kind === option && <CheckCircle2 size={17} className="story-kind-check" aria-hidden="true" />}
                </span>
                <strong>{t(`stories:kinds.${option}.name`)}</strong>
                <small>{t(`stories:kinds.${option}.hint`)}</small>
              </Button>
            );
          })}
        </div>

        {/* The front page, as it will open. The cover carries its own menu, and
            the name and subtitle are set where they will be read. */}
        <div className="story-new-story-page">
          <StoryCoverBanner
            coverUrl={cover?.url ?? null}
            pickerTitle={t("stories:fields.coverPickerTitle")}
            extraActions={bookCover}
            onPick={(asset) => setCover({ id: asset.id, url: asset.coverUrl })}
            onClear={() => setCover(null)}
          />

          {(previewDate || previewPlace) && (
            <p className="story-edit-dateline">
              {previewDate}
              {previewDate && previewPlace && <span className="story-edit-dot" aria-hidden="true">·</span>}
              {previewPlace && (
                <span className="story-new-story-place">
                  <MapPin size={13} aria-hidden="true" /> {previewPlace}
                </span>
              )}
            </p>
          )}

          <input
            autoFocus
            className="story-new-story-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("stories:fields.titlePlaceholder")}
            maxLength={160}
            aria-label={t("stories:fields.title")}
          />
          <input
            className="story-new-story-subtitle"
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            placeholder={t("stories:fields.subtitlePlaceholder")}
            maxLength={300}
            aria-label={t("stories:fields.subtitle")}
          />
        </div>

        {/* What the words can't say, in the same card the chapter page wears. */}
        <section className="story-edit-settings story-new-story-settings">
          <p className="story-edit-settings-head is-static">
            <KindIcon size={16} aria-hidden="true" />
            <span>{t("stories:create.settings")}</span>
          </p>

          <div className="story-edit-settings-body">
            {kind !== "review" && (
              <PartialDateField
                className="story-edit-setting"
                label={kind === "journal"
                  ? t("stories:chapter.startDateField")
                  : `${t("stories:chapter.dateField")} (${t("stories:fields.optional")})`}
                value={date}
                onChange={setDate}
                placeholder={t("stories:chapter.datePlaceholder")}
              />
            )}

            {kind === "journal" && (
              <PartialDateField
                className="story-edit-setting"
                label={`${t("stories:chapter.endDateField")} (${t("stories:fields.optional")})`}
                value={endDate}
                onChange={setEndDate}
                placeholder={t("stories:chapter.endDatePlaceholder")}
              />
            )}

            {kind === "memory" && (
              <label className="field story-edit-setting">
                <span>{t("stories:chapter.placeField")} <small className="muted">{t("stories:fields.optional")}</small></span>
                <input
                  value={place}
                  onChange={(event) => setPlace(event.target.value)}
                  placeholder={t("stories:chapter.placePlaceholder")}
                  maxLength={200}
                />
              </label>
            )}

            {kind === "journal" && (
              <p className="muted story-create-hint story-edit-setting-wide">{t("stories:create.journalRangeHint")}</p>
            )}

            {kind === "review" && (
              <div className="story-edit-setting story-create-book story-edit-setting-wide">
                <Button variant="secondary" compact onClick={() => setPickingBook(true)} disabled={saving}>
                  <BookText size={15} aria-hidden="true" />
                  <span>{book ? t("stories:create.changeBook") : t("stories:create.pickBook")}</span>
                </Button>
                {book && <span className="story-create-book-title">{book.title}</span>}
              </div>
            )}
          </div>
        </section>

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
          onPick={(id, entityType, bookTitle, bookCoverUrl) => {
            setPickingBook(false);
            if (!entityType) return;
            setBook({ id, entityType, title: bookTitle ?? "", coverUrl: bookCoverUrl ?? null });
            // Nothing chosen yet? The book's own artwork is the obvious cover
            // for a review, so it is offered by being there, not by asking.
            setCover((current) => current ?? (bookCoverUrl ? { id, url: bookCoverUrl } : null));
          }}
          onClose={() => setPickingBook(false)}
        />
      )}
    </Modal>
  );
}
