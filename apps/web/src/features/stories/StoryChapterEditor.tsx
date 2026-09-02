import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MapPin, Settings, Trash2 } from "lucide-react";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { InlineEdit } from "../../shared/InlineEdit";
import { PartialDateField } from "../../shared/PartialDateField";
import { formatPartialDateLong, formatPartialDateRange } from "../../shared/utils";
import { AddStoryBlock } from "./AddStoryBlock";
import { StoryBlockEditor, blockMoveTargets } from "./StoryBlockEditor";
import { StoryCoverBanner } from "./StoryCoverBanner";
import { StoryMapModal } from "./StoryMapModal";
import { chapterLabel, type StoryBlockKind, type StoryChapter, type StoryDetail } from "./types";

// One chapter, laid out the way it reads: cover, dateline, title, standfirst,
// then its blocks. Everything on the page is edited where it sits — the only
// form is the settings card, and it holds exactly the things that have no place
// in the prose (the dates behind the dateline, the pin, the chapter note).
export function StoryChapterEditor({
  story,
  chapter,
  index,
  busy,
  onPatch,
  onRemove,
  onAddBlock,
  blockActions
}: {
  story: StoryDetail;
  chapter: StoryChapter;
  index: number;
  busy: boolean;
  onPatch: (fields: Record<string, unknown>) => void;
  onRemove: () => void;
  /** afterId puts the new block straight after that one, where it was asked
   *  for, rather than at the end of the chapter. */
  onAddBlock: (kind: StoryBlockKind, fields?: Record<string, unknown>, afterId?: string) => void;
  blockActions: {
    move: (blockId: string, direction: -1 | 1) => void;
    moveToChapter: (blockId: string, chapterId: string) => void;
    reorder: (orderedIds: string[]) => void;
    patch: (blockId: string, fields: Record<string, unknown>) => void;
    remove: (blockId: string) => void;
  };
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pinning, setPinning] = useState(false);
  // Settings open themselves for a chapter that has nothing set yet — there is
  // otherwise no hint that a date and a place belong to it.
  const [settingsOpen, setSettingsOpen] = useState(!chapter.date && !chapter.place);
  const [dates, setDates] = useState({ date: chapter.date ?? "", endDate: chapter.endDate ?? "" });
  const [place, setPlace] = useState(chapter.place ?? "");
  const [note, setNote] = useState(chapter.description ?? "");

  useEffect(() => {
    setDates({ date: chapter.date ?? "", endDate: chapter.endDate ?? "" });
    setPlace(chapter.place ?? "");
    setNote(chapter.description ?? "");
  }, [chapter.id, chapter.date, chapter.endDate, chapter.place, chapter.description]);

  // Block drag-and-drop: the order under the pointer is local until the drop,
  // and the server's order is what re-renders afterwards.
  const [order, setOrder] = useState(chapter.blocks.map((block) => block.id));
  const signature = chapter.blocks.map((block) => block.id).join(",");
  const dragging = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Readable during an event: the drop handler reports the order from here, not
  // from inside a state updater — an updater runs during render, and calling
  // back from there is a setState in another component's render pass.
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = signature ? signature.split(",") : [];
    setOrder(orderRef.current);
  }, [signature]);

  const dragOver = (id: string) => {
    const from = dragging.current;
    if (!from || from === id) return;
    const next = [...orderRef.current];
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(id);
    if (fromIndex < 0 || toIndex < 0) return;
    next.splice(toIndex, 0, ...next.splice(fromIndex, 1));
    orderRef.current = next;
    setOrder(next);
  };

  const drop = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setDraggingId(null);
    if (orderRef.current.join(",") !== signature) blockActions.reorder(orderRef.current);
  };

  const label = chapterLabel(story, chapter, index);
  const dateline = [
    label,
    chapter.endDate
      ? formatPartialDateRange(chapter.date, chapter.endDate)
      : formatPartialDateLong(chapter.date)
  ].filter(Boolean);
  const byId = new Map(chapter.blocks.map((block) => [block.id, block]));
  const blocks = order.map((id) => byId.get(id)).filter((block): block is NonNullable<typeof block> => Boolean(block));
  const siblings = blockMoveTargets(story.chapters, chapter.id, (other, otherIndex) =>
    chapterLabel(story, other, otherIndex));

  const commitDates = () => {
    const nextDate = dates.date.trim();
    const nextEnd = dates.endDate.trim();
    const fields: Record<string, unknown> = {};
    if (nextDate !== (chapter.date ?? "")) fields.date = nextDate || null;
    if (nextEnd !== (chapter.endDate ?? "")) fields.endDate = nextEnd || null;
    if (Object.keys(fields).length > 0) onPatch(fields);
  };

  return (
    <div className="story-edit-chapter">
      <StoryCoverBanner
        // No cover of its own? Wear the story's, so a chapter page opens on a
        // picture from the day it was written about rather than on nothing.
        coverUrl={chapter.hero?.coverUrl ?? story.coverUrl}
        inherited={!chapter.hero}
        pickerTitle={t("stories:chapter.heroPickerTitle")}
        pin={chapter.placeLat != null && chapter.placeLng != null
          ? { lat: chapter.placeLat, lng: chapter.placeLng, label: chapter.place ?? label }
          : null}
        useMap={chapter.heroMap}
        onPick={(asset) => onPatch({ heroItemId: asset.id, heroMap: false })}
        onClear={() => onPatch({ heroItemId: null, heroMap: false })}
        onUseMap={(next) => onPatch({ heroMap: next })}
      />

      <p className="story-edit-dateline">
        {dateline.map((part, partIndex) => (
          <span key={part}>
            {partIndex > 0 && <span className="story-edit-dot" aria-hidden="true">·</span>}
            {chapter.dateApprox && partIndex > 0 ? t("stories:chapter.approx", { date: part }) : part}
          </span>
        ))}
      </p>

      <h2 className="story-edit-chapter-title">
        <InlineEdit
          value={chapter.title ?? ""}
          ariaLabel={t("stories:chapter.titleField")}
          placeholder={t("stories:chapter.titlePlaceholder")}
          maxLength={160}
          onSave={(next) => onPatch({ title: next || null })}
        />
      </h2>

      <div className="story-edit-standfirst">
        <InlineEdit
          value={chapter.standfirst ?? ""}
          ariaLabel={t("stories:chapter.standfirstField")}
          placeholder={t("stories:chapter.standfirstPlaceholder")}
          maxLength={300}
          multiline
          rows={3}
          onSave={(next) => onPatch({ standfirst: next || null })}
        />
      </div>

      <section className={`story-edit-settings${settingsOpen ? "" : " is-collapsed"}`}>
        <button
          type="button"
          className="story-edit-settings-head"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-expanded={settingsOpen}
        >
          <Settings size={16} aria-hidden="true" />
          <span>{t("stories:edit.chapterSettings")}</span>
          <ChevronDown size={16} aria-hidden="true" className="story-edit-settings-chevron" />
        </button>

        {settingsOpen && (
          <div className="story-edit-settings-body">
            <PartialDateField
              className="story-edit-setting"
              label={t("stories:chapter.startDateField")}
              value={dates.date}
              onChange={(value) => setDates((state) => ({ ...state, date: value }))}
              onBlur={commitDates}
              placeholder={t("stories:chapter.datePlaceholder")}
            />
            <PartialDateField
              className="story-edit-setting"
              label={`${t("stories:chapter.endDateField")} (${t("stories:fields.optional")})`}
              value={dates.endDate}
              onChange={(value) => setDates((state) => ({ ...state, endDate: value }))}
              onBlur={commitDates}
              placeholder={t("stories:chapter.endDatePlaceholder")}
            />

            <div className="story-edit-setting story-edit-approx">
              <label className="field">
                <input
                  type="checkbox"
                  checked={chapter.dateApprox}
                  onChange={(event) => onPatch({ dateApprox: event.target.checked })}
                  disabled={!chapter.date}
                />
                <span>{t("stories:chapter.approxLabel")}</span>
              </label>
              <p className="muted">{t("stories:edit.approxHint")}</p>
            </div>

            <label className="field story-edit-setting story-edit-place">
              <span>{t("stories:chapter.placeField")}</span>
              <input
                value={place}
                onChange={(event) => setPlace(event.target.value)}
                onBlur={() => {
                  const next = place.trim();
                  if (next !== (chapter.place ?? "")) onPatch({ place: next || null });
                }}
                placeholder={t("stories:chapter.placePlaceholder")}
                maxLength={200}
              />
            </label>

            <div className="story-edit-setting story-edit-pin-actions">
              <Button variant="secondary" compact onClick={() => setPinning(true)} disabled={busy}>
                <MapPin size={15} aria-hidden="true" />
                <span>{chapter.placeLat != null ? t("stories:chapter.movePin") : t("stories:chapter.setPin")}</span>
              </Button>
              {chapter.placeLat != null && (
                <>
                  <Button
                    variant="secondary"
                    compact
                    className={chapter.heroMap ? "is-current" : undefined}
                    aria-pressed={chapter.heroMap}
                    onClick={() => onPatch({ heroMap: !chapter.heroMap })}
                    disabled={busy}
                  >
                    <Settings size={15} aria-hidden="true" />
                    <span>{chapter.heroMap ? t("stories:edit.coverUsePhoto") : t("stories:edit.coverUseMap")}</span>
                  </Button>
                  <Button
                    variant="text"
                    compact
                    onClick={() => onPatch({ placeLat: null, placeLng: null, heroMap: false })}
                    disabled={busy}
                  >
                    {t("stories:chapter.clearPin")}
                  </Button>
                </>
              )}
            </div>

            <label className="field story-edit-setting story-edit-note">
              <span>{t("stories:chapter.descriptionField")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                  const next = note.trim();
                  if (next !== (chapter.description ?? "")) onPatch({ description: next || null });
                }}
                placeholder={t("stories:chapter.descriptionPlaceholder")}
                rows={2}
                maxLength={2000}
              />
            </label>

            <div className="story-edit-setting story-edit-chapter-delete">
              <Button
                variant="text"
                compact
                danger
                onClick={() => setConfirmDelete(true)}
                disabled={story.chapters.length <= 1}
                title={story.chapters.length <= 1 ? t("stories:chapter.lastOne") : undefined}
              >
                <Trash2 size={15} aria-hidden="true" />
                <span>{t("stories:actions.removeChapter")}</span>
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className="story-edit-blocks">
        {blocks.map((block, blockIndex) => (
          <div className="story-edit-block-slot" key={block.id}>
            <StoryBlockEditor
              block={block}
              first={blockIndex === 0}
              last={blockIndex === blocks.length - 1}
              busy={busy}
              siblings={siblings}
              dragging={draggingId === block.id}
              onDragStart={() => { dragging.current = block.id; setDraggingId(block.id); }}
              onDragOver={() => dragOver(block.id)}
              onDrop={drop}
              onMove={(direction) => blockActions.move(block.id, direction)}
              onMoveToChapter={(chapterId) => blockActions.moveToChapter(block.id, chapterId)}
              onPatch={(patch) => blockActions.patch(block.id, patch)}
              onRemove={() => blockActions.remove(block.id)}
            />
            <AddStoryBlock
              storyId={story.id}
              storyTags={story.tags}
              busy={busy}
              onAdd={(kind, fields) => onAddBlock(kind, fields, block.id)}
            />
          </div>
        ))}

        {blocks.length === 0 && (
          <div className="story-edit-blocks-empty">
            <p className="muted">{t("stories:edit.chapterEmpty")}</p>
            <AddStoryBlock storyId={story.id} storyTags={story.tags} busy={busy} onAdd={onAddBlock} />
          </div>
        )}
      </div>

      {pinning && (
        <StoryMapModal
          initial={chapter.placeLat != null && chapter.placeLng != null
            ? { lat: chapter.placeLat, lng: chapter.placeLng, zoom: null, label: chapter.place }
            : null}
          onSave={(value) => {
            setPinning(false);
            // The pin names the place too, unless the author already typed one.
            const names = Boolean(value.label && !place.trim());
            onPatch({ placeLat: value.lat, placeLng: value.lng, ...(names ? { place: value.label } : {}) });
            if (names) setPlace(value.label ?? "");
          }}
          onClose={() => setPinning(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("stories:confirm.removeChapterTitle", { name: chapter.title || label })}
          confirmLabel={t("stories:actions.removeChapter")}
          danger
          busy={busy}
          onConfirm={() => { setConfirmDelete(false); onRemove(); }}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:confirm.removeChapterBody", { count: chapter.blocks.length })}
        </ConfirmDialog>
      )}
    </div>
  );
}
