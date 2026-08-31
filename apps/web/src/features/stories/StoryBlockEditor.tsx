import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Eye, MapPin, Pencil, Trash2 } from "lucide-react";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { StoryBlockView } from "./StoryBlockView";
import { StoryMapModal } from "./StoryMapModal";
import type { StoryBlock } from "./types";

// One block inside the editor: the reader's own rendering, wrapped in controls.
// What the author arranges is literally what a reader sees, because the preview
// IS StoryBlockView.
export function StoryBlockEditor({
  block,
  first,
  last,
  busy,
  onMove,
  onPatch,
  onRemove
}: {
  block: StoryBlock;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (direction: -1 | 1) => void;
  onPatch: (fields: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingMap, setEditingMap] = useState(false);
  // Text is edited in place; everything else previews as the reader sees it.
  const [writing, setWriting] = useState(block.kind === "text" && !block.body);
  const [draft, setDraft] = useState(block.body ?? "");
  const [caption, setCaption] = useState(block.caption ?? "");

  // A reload (any sibling edit re-reads the story) must not clobber what is
  // being typed here — only adopt server values that actually changed.
  useEffect(() => { setDraft(block.body ?? ""); }, [block.body]);
  useEffect(() => { setCaption(block.caption ?? ""); }, [block.caption]);

  const saveText = () => {
    if (draft === (block.body ?? "")) return;
    onPatch({ body: draft });
  };

  const saveCaption = () => {
    const next = caption.trim();
    if (next === (block.caption ?? "")) return;
    onPatch({ caption: next || null });
  };

  return (
    <div className="story-edit-block">
      <div className="story-edit-block-bar">
        <span className="story-edit-kind">{t(`stories:kind.${block.kind}`)}</span>
        <div className="story-edit-block-actions">
          {block.kind === "text" && (
            <Button
              variant="icon"
              onClick={() => { if (writing) saveText(); setWriting(!writing); }}
              aria-label={writing ? t("stories:actions.preview") : t("stories:actions.write")}
              title={writing ? t("stories:actions.preview") : t("stories:actions.write")}
            >
              {writing ? <Eye size={15} /> : <Pencil size={15} />}
            </Button>
          )}
          {block.kind === "map" && (
            <Button
              variant="icon"
              onClick={() => setEditingMap(true)}
              aria-label={t("stories:map.editTitle")}
              title={t("stories:map.editTitle")}
            >
              <MapPin size={15} />
            </Button>
          )}
          {block.kind === "media" && block.asset?.kind === "photo" && (
            <Button
              variant="icon"
              className={block.layout === "wide" ? "accent-gold" : undefined}
              onClick={() => onPatch({ layout: block.layout === "wide" ? "default" : "wide" })}
              aria-label={t("stories:actions.toggleWide")}
              title={t("stories:actions.toggleWide")}
            >
              <span aria-hidden="true" className="story-wide-glyph">↔</span>
            </Button>
          )}
          <Button variant="icon" onClick={() => onMove(-1)} disabled={first || busy} aria-label={t("stories:actions.moveUp")}>
            <ChevronUp size={15} />
          </Button>
          <Button variant="icon" onClick={() => onMove(1)} disabled={last || busy} aria-label={t("stories:actions.moveDown")}>
            <ChevronDown size={15} />
          </Button>
          <Button variant="icon" danger onClick={() => setConfirmDelete(true)} aria-label={t("stories:actions.removeBlock")}>
            <Trash2 size={15} />
          </Button>
        </div>
      </div>

      {block.kind === "text" && writing ? (
        <textarea
          className="story-text-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={saveText}
          placeholder={t("stories:block.textPlaceholder")}
          rows={8}
          maxLength={20000}
        />
      ) : (
        <StoryBlockView block={block} onOpenMedia={() => {}} onPlaySlideshow={() => {}} />
      )}

      {block.kind !== "text" && block.kind !== "map" && (
        <label className="field story-caption-field">
          <span>{t("stories:block.caption")} <small className="muted">{t("stories:fields.optional")}</small></span>
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            onBlur={saveCaption}
            placeholder={t("stories:block.captionPlaceholder")}
            maxLength={500}
          />
        </label>
      )}

      {editingMap && (
        <StoryMapModal
          initial={block.lat != null && block.lng != null
            ? { lat: block.lat, lng: block.lng, zoom: block.zoom, label: block.label }
            : null}
          onSave={(value) => { setEditingMap(false); onPatch(value); }}
          onClose={() => setEditingMap(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t("stories:confirm.removeBlockTitle", { kind: t(`stories:kind.${block.kind}`) })}
          confirmLabel={t("stories:actions.removeBlock")}
          danger
          busy={busy}
          onConfirm={() => { setConfirmDelete(false); onRemove(); }}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:confirm.removeBlockBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}
