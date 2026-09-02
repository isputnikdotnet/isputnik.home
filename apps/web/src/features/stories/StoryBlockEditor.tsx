import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  Eye,
  GripVertical,
  MapPin,
  MoveHorizontal,
  Pencil,
  Trash2
} from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "../../shared/ActionMenu";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { InlineEdit } from "../../shared/InlineEdit";
import { StoryBlockView } from "./StoryBlockView";
import { StoryMapModal } from "./StoryMapModal";
import { StoryMarkdown } from "./StoryMarkdown";
import type { StoryBlock, StoryChapter } from "./types";

// One block as a card: a grip to drag it, its own heading, the reader's
// rendering of its content, and a menu holding everything else. What the author
// arranges is literally what a reader sees, because the preview IS
// StoryBlockView — the card is chrome around it, never a second rendering.
export function StoryBlockEditor({
  block,
  first,
  last,
  busy,
  siblings,
  onMove,
  onMoveToChapter,
  onPatch,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  dragging
}: {
  block: StoryBlock;
  first: boolean;
  last: boolean;
  busy: boolean;
  /** The story's other chapters — a block can be moved into one of them. */
  siblings: { id: string; label: string }[];
  onMove: (direction: -1 | 1) => void;
  onMoveToChapter: (chapterId: string) => void;
  onPatch: (fields: Record<string, unknown>) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  dragging: boolean;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingMap, setEditingMap] = useState(false);
  // A text block opens ready to type when it is still empty — a block added
  // from the menu exists only to be written in.
  const [writing, setWriting] = useState(block.kind === "text" && !block.body);
  const [draft, setDraft] = useState(block.body ?? "");

  // A reload (any sibling edit re-reads the story) must not clobber what is
  // being typed here — only adopt the server's text when it actually changed.
  useEffect(() => { setDraft(block.body ?? ""); }, [block.body]);

  const saveText = () => {
    if (draft === (block.body ?? "")) return;
    onPatch({ body: draft });
  };

  const items: ActionMenuItem[] = [];
  if (block.kind === "text") {
    items.push({
      key: "write",
      label: writing ? t("stories:actions.preview") : t("stories:actions.write"),
      icon: writing ? <Eye size={15} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />,
      onSelect: () => { if (writing) saveText(); setWriting(!writing); }
    });
  }
  if (block.kind === "map") {
    items.push({
      key: "map",
      label: t("stories:map.editTitle"),
      icon: <MapPin size={15} aria-hidden="true" />,
      onSelect: () => setEditingMap(true)
    });
  }
  if (block.kind === "media" && block.asset?.kind === "photo") {
    items.push({
      key: "wide",
      label: t("stories:actions.toggleWide"),
      icon: <MoveHorizontal size={15} aria-hidden="true" />,
      onSelect: () => onPatch({ layout: block.layout === "wide" ? "default" : "wide" })
    });
  }
  items.push({
    key: "up",
    label: t("stories:actions.moveUp"),
    icon: <ArrowUp size={15} aria-hidden="true" />,
    disabledReason: first || busy ? t("stories:edit.alreadyFirst") : undefined,
    onSelect: () => onMove(-1)
  });
  items.push({
    key: "down",
    label: t("stories:actions.moveDown"),
    icon: <ArrowDown size={15} aria-hidden="true" />,
    disabledReason: last || busy ? t("stories:edit.alreadyLast") : undefined,
    onSelect: () => onMove(1)
  });
  for (const sibling of siblings) {
    items.push({
      key: `to-${sibling.id}`,
      label: t("stories:edit.moveToChapter", { name: sibling.label }),
      icon: <CornerDownRight size={15} aria-hidden="true" />,
      onSelect: () => onMoveToChapter(sibling.id)
    });
  }
  items.push({
    key: "delete",
    label: t("stories:actions.removeBlock"),
    icon: <Trash2 size={15} aria-hidden="true" />,
    danger: true,
    onSelect: () => setConfirmDelete(true)
  });

  return (
    <div
      className={`story-edit-block${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); onDragOver(); }}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
    >
      <span
        className="story-edit-grip"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDrop}
        aria-hidden="true"
      >
        <GripVertical size={16} />
      </span>

      <div className="story-edit-block-body">
        <div className="story-edit-block-head">
          <InlineEdit
            className="story-edit-block-heading"
            value={block.heading ?? ""}
            ariaLabel={t("stories:edit.blockHeading")}
            placeholder={t("stories:edit.blockHeadingPlaceholder")}
            maxLength={200}
            onSave={(next) => onPatch({ heading: next || null })}
          />
          <ActionMenu
            label={t("stories:edit.blockMenu")}
            trigger="icon"
            items={items}
            className="story-edit-block-menu"
          />
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
            aria-label={t("stories:kind.text")}
          />
        ) : block.kind === "text" ? (
          // Prose reads as prose and turns into a field where it sits, the way
          // the chapter's own title and standfirst do.
          <div
            className="story-edit-block-prose"
            role="button"
            tabIndex={0}
            onClick={() => setWriting(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setWriting(true); }
            }}
          >
            {block.body
              ? <StoryMarkdown source={block.body} />
              : <p className="muted">{t("stories:block.textPlaceholder")}</p>}
          </div>
        ) : (
          <StoryBlockView block={block} onOpenMedia={() => {}} onPlaySlideshow={() => {}} />
        )}

        {block.kind !== "text" && block.kind !== "map" && (
          <InlineEdit
            className="story-edit-block-caption"
            value={block.caption ?? ""}
            ariaLabel={t("stories:block.caption")}
            placeholder={t("stories:block.captionPlaceholder")}
            maxLength={500}
            onSave={(next) => onPatch({ caption: next || null })}
          />
        )}
      </div>

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

/** The chapters a block can be moved into — everything but its own. */
export function blockMoveTargets(
  chapters: StoryChapter[],
  currentId: string,
  label: (chapter: StoryChapter, index: number) => string
): { id: string; label: string }[] {
  return chapters
    .map((chapter, index) => ({ id: chapter.id, label: label(chapter, index) }))
    .filter((chapter) => chapter.id !== currentId);
}
