import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Images, MapPin, Mic, Play, Plus, Quote, Trash2, Type, UserRound } from "lucide-react";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PartialDateField } from "../../shared/PartialDateField";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryBlockEditor } from "./StoryBlockEditor";
import { StoryRefPicker, type RefKind } from "./StoryRefPicker";
import { StoryMapModal } from "./StoryMapModal";
import { StoryAudioModal } from "./StoryAudioModal";
import type { StoryBlockKind, StoryChapter } from "./types";

// One chapter in the editor: its heading fields, its blocks, and the row that
// adds the next block. Chapter fields save on blur — there is no Save button in
// this editor, so nothing can be lost by navigating away.
export function StoryChapterEditor({
  chapter,
  storyId,
  index,
  total,
  busy,
  showChapterFields,
  storyTags,
  onPatch,
  onRemove,
  onMove,
  onAddBlock,
  blockActions
}: {
  chapter: StoryChapter;
  storyId: string;
  index: number;
  total: number;
  busy: boolean;
  /** A single untitled chapter hides its heading fields behind "Add chapter
   *  details" — a simple journal page shouldn't open with a form. */
  showChapterFields: boolean;
  /** The story's tags, so the pickers can offer matching content first. */
  storyTags: string[];
  onPatch: (fields: Record<string, unknown>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onAddBlock: (kind: StoryBlockKind, fields?: Record<string, unknown>) => void;
  blockActions: {
    move: (blockId: string, direction: -1 | 1) => void;
    patch: (blockId: string, fields: Record<string, unknown>) => void;
    remove: (blockId: string) => void;
  };
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [picker, setPicker] = useState<"photo" | "map" | "audio" | RefKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fields, setFields] = useState({
    title: chapter.title ?? "",
    date: chapter.date ?? "",
    endDate: chapter.endDate ?? "",
    place: chapter.place ?? "",
    description: chapter.description ?? ""
  });

  // Adopt server values after a reload without discarding an in-progress edit.
  useEffect(() => {
    setFields({
      title: chapter.title ?? "",
      date: chapter.date ?? "",
      endDate: chapter.endDate ?? "",
      place: chapter.place ?? "",
      description: chapter.description ?? ""
    });
  }, [chapter.title, chapter.date, chapter.endDate, chapter.place, chapter.description]);

  const commit = (key: keyof typeof fields, current: string | null) => {
    const next = fields[key].trim();
    if (next === (current ?? "")) return;
    onPatch({ [key]: next || null });
  };

  return (
    <section className="story-edit-chapter">
      <header className="story-edit-chapter-head">
        <span className="story-edit-chapter-number">
          {t("stories:chapter.number", { number: index + 1 })}
        </span>
        <div className="story-edit-chapter-actions">
          <Button variant="icon" onClick={() => onMove(-1)} disabled={index === 0 || busy} aria-label={t("stories:actions.moveChapterUp")}>
            <ChevronUp size={15} />
          </Button>
          <Button variant="icon" onClick={() => onMove(1)} disabled={index === total - 1 || busy} aria-label={t("stories:actions.moveChapterDown")}>
            <ChevronDown size={15} />
          </Button>
          <Button
            variant="icon"
            danger
            onClick={() => setConfirmDelete(true)}
            disabled={total <= 1}
            aria-label={t("stories:actions.removeChapter")}
            title={total <= 1 ? t("stories:chapter.lastOne") : t("stories:actions.removeChapter")}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </header>

      {showChapterFields && (
        <div className="story-chapter-fields">
          <label className="field story-chapter-title-field">
            <span>{t("stories:chapter.titleField")}</span>
            <input
              value={fields.title}
              onChange={(event) => setFields((state) => ({ ...state, title: event.target.value }))}
              onBlur={() => commit("title", chapter.title)}
              placeholder={t("stories:chapter.titlePlaceholder")}
              maxLength={160}
            />
          </label>

          <div className="story-chapter-date-row">
            <PartialDateField
              label={t("stories:chapter.dateField")}
              value={fields.date}
              onChange={(value) => setFields((state) => ({ ...state, date: value }))}
              placeholder={t("stories:chapter.datePlaceholder")}
            />
            <PartialDateField
              label={t("stories:chapter.endDateField")}
              value={fields.endDate}
              onChange={(value) => setFields((state) => ({ ...state, endDate: value }))}
              placeholder={t("stories:chapter.endDatePlaceholder")}
            />
            <Button
              variant="secondary"
              compact
              onClick={() => {
                commit("date", chapter.date);
                commit("endDate", chapter.endDate);
              }}
              disabled={busy}
            >
              {t("stories:actions.applyDates")}
            </Button>
          </div>

          <label className="field story-chapter-approx">
            <input
              type="checkbox"
              checked={chapter.dateApprox}
              onChange={(event) => onPatch({ dateApprox: event.target.checked })}
              disabled={!chapter.date}
            />
            <span>{t("stories:chapter.approxLabel")}</span>
          </label>

          <label className="field">
            <span>{t("stories:chapter.placeField")} <small className="muted">{t("stories:fields.optional")}</small></span>
            <input
              value={fields.place}
              onChange={(event) => setFields((state) => ({ ...state, place: event.target.value }))}
              onBlur={() => commit("place", chapter.place)}
              placeholder={t("stories:chapter.placePlaceholder")}
              maxLength={200}
            />
          </label>

          <label className="field">
            <span>{t("stories:chapter.descriptionField")} <small className="muted">{t("stories:fields.optional")}</small></span>
            <textarea
              value={fields.description}
              onChange={(event) => setFields((state) => ({ ...state, description: event.target.value }))}
              onBlur={() => commit("description", chapter.description)}
              placeholder={t("stories:chapter.descriptionPlaceholder")}
              rows={2}
              maxLength={2000}
            />
          </label>
        </div>
      )}

      <div className="story-edit-blocks">
        {chapter.blocks.map((block, blockIndex) => (
          <StoryBlockEditor
            key={block.id}
            block={block}
            first={blockIndex === 0}
            last={blockIndex === chapter.blocks.length - 1}
            busy={busy}
            onMove={(direction) => blockActions.move(block.id, direction)}
            onPatch={(patch) => blockActions.patch(block.id, patch)}
            onRemove={() => blockActions.remove(block.id)}
          />
        ))}
        {chapter.blocks.length === 0 && (
          <p className="muted story-chapter-empty">{t("stories:edit.chapterEmpty")}</p>
        )}
      </div>

      <div className="story-add-block">
        <span className="story-add-block-label">
          <Plus size={14} aria-hidden="true" /> {t("stories:edit.addBlock")}
        </span>
        <Button variant="secondary" compact onClick={() => onAddBlock("text", { body: "" })} disabled={busy}>
          <Type size={15} aria-hidden="true" />
          <span>{t("stories:kind.text")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("photo")} disabled={busy}>
          <Images size={15} aria-hidden="true" />
          <span>{t("stories:kind.media")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("album")} disabled={busy}>
          <Images size={15} aria-hidden="true" />
          <span>{t("stories:kind.album")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("slideshow")} disabled={busy}>
          <Play size={15} aria-hidden="true" />
          <span>{t("stories:kind.slideshow")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("map")} disabled={busy}>
          <MapPin size={15} aria-hidden="true" />
          <span>{t("stories:kind.map")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("person")} disabled={busy}>
          <UserRound size={15} aria-hidden="true" />
          <span>{t("stories:kind.person")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("quote")} disabled={busy}>
          <Quote size={15} aria-hidden="true" />
          <span>{t("stories:kind.quote")}</span>
        </Button>
        <Button variant="secondary" compact onClick={() => setPicker("audio")} disabled={busy}>
          <Mic size={15} aria-hidden="true" />
          <span>{t("stories:kind.audio")}</span>
        </Button>
      </div>

      {picker === "photo" && (
        <PhotoPicker
          title={t("stories:picker.photoTitle")}
          pick="any"
          onPick={(asset) => { setPicker(null); onAddBlock("media", { entityId: asset.id }); }}
          onClose={() => setPicker(null)}
        />
      )}

      {(picker === "album" || picker === "slideshow" || picker === "person" || picker === "quote") && (
        <StoryRefPicker
          kind={picker}
          storyTags={storyTags}
          onPick={(id) => { const kind = picker; setPicker(null); onAddBlock(kind, { entityId: id }); }}
          onClose={() => setPicker(null)}
        />
      )}

      {picker === "audio" && (
        <StoryAudioModal
          storyId={storyId}
          onAdded={(audioId) => { setPicker(null); onAddBlock("audio", { entityId: audioId }); }}
          onClose={() => setPicker(null)}
        />
      )}

      {picker === "map" && (
        <StoryMapModal
          initial={null}
          onSave={(value) => { setPicker(null); onAddBlock("map", value); }}
          onClose={() => setPicker(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("stories:confirm.removeChapterTitle", {
            name: chapter.title || t("stories:chapter.number", { number: index + 1 })
          })}
          confirmLabel={t("stories:actions.removeChapter")}
          danger
          busy={busy}
          onConfirm={() => { setConfirmDelete(false); onRemove(); }}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:confirm.removeChapterBody", { count: chapter.blocks.length })}
        </ConfirmDialog>
      )}
    </section>
  );
}
