import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Columns2, ExternalLink, Folder, ImageOff, Images, Square } from "lucide-react";
import { Modal } from "../../../../shared/Modal";
import { Button } from "../../../../shared/Button";
import { formatBytes } from "../../../../shared/utils";
import i18n from "../../../../i18n";
import { topLevelHint, topLevelLabel } from "./shared";

// Full-size look at the copies in one duplicate set, so the decision can be made on
// the pictures rather than on filenames and byte counts. Two modes: one copy at a
// time with next/previous, or two side by side — which is the whole point for the
// near-identical tier, where the copies differ in ways a thumbnail can't show.
//
// Images are the web-sized preview, not the original; "Open original" is a link for
// when the actual file matters.

export interface ViewerMember {
  itemId: string;
  libraryName: string;
  path: string;
  coverUrl: string | null;
  previewUrl: string | null;
  /** NULL when the item is gone — a cleanup's snapshot outlives the photos it describes,
   *  so there may be nothing left to open. */
  fileUrl: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
}

function fileName(member: ViewerMember): string {
  return member.path.split("/").pop() || member.path;
}

function dimensions(member: ViewerMember): string {
  return member.width && member.height ? `${member.width} × ${member.height}` : i18n.t("controlDash:dupes.unknownSize");
}

function folderOf(member: ViewerMember): string {
  const cut = member.path.lastIndexOf("/");
  return cut === -1 ? "" : member.path.slice(0, cut);
}

// Just the folder itself, not its ancestors; the full path is on the tooltip.
// A copy in no folder reads "Top level", not "Library root" — see topLevelLabel().
function folderName(member: ViewerMember): string {
  const folder = folderOf(member);
  return folder ? folder.split("/").pop() || folder : topLevelLabel();
}

function Pane({
  member,
  mark,
  onToggleMark,
  busy,
  readOnly
}: {
  member: ViewerMember;
  mark: "keep" | "trash";
  onToggleMark: () => void;
  busy: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const src = member.previewUrl ?? member.coverUrl;
  const picture = src
    ? <img src={src} alt={fileName(member)} />
    : <span className="dup-view-missing"><ImageOff size={28} aria-hidden="true" /></span>;
  const chip = <span className="dup-view-chip" aria-hidden="true">{mark === "keep" ? t("controlDash:dupes.badgeKeep") : t("controlDash:dupes.badgeDelete")}</span>;

  return (
    <div className={`dup-view-pane${mark === "keep" ? " is-keep" : " is-trash"}`}>
      {/* Read-only is not a disabled button: a cleanup job's keeper was settled by the
          scan, so there is no control here to grey out. Rendering a real button that
          does nothing would promise an action that does not exist, and rendering a
          disabled one would suggest the action exists but is unavailable. */}
      {readOnly ? (
        <div className="dup-view-stage is-static">
          {picture}
          {chip}
        </div>
      ) : (
        <Button
          variant="text"
          className="dup-view-stage"
          aria-pressed={mark === "trash"}
          disabled={busy}
          title={mark === "keep" ? t("controlDash:dupes.markedKeepHint") : t("controlDash:dupes.markedDeleteHint")}
          onClick={onToggleMark}
        >
          {picture}
          {chip}
        </Button>
      )}
      <div className="dup-view-meta">
        <strong title={member.path}>{fileName(member)}</strong>
        <span className="dup-view-where">
          <Images size={12} aria-hidden="true" />
          <span>{member.libraryName}</span>
        </span>
        <span className="dup-view-where" title={folderOf(member) || topLevelHint()}>
          <Folder size={12} aria-hidden="true" />
          <span>{folderName(member)}</span>
        </span>
        <span className="datagrid-muted">
          {dimensions(member)}{member.size != null ? ` · ${formatBytes(member.size)}` : ""}
        </span>
        {member.fileUrl && (
          <a className="dup-view-original" href={member.fileUrl} target="_blank" rel="noreferrer">
            <span>{t("controlDash:dupes.openOriginal")}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

export function DuplicateViewer({
  title,
  members,
  markOf,
  onToggleMark = () => { /* read-only */ },
  onClose,
  busy = false,
  readOnly = false
}: {
  title: string;
  members: ViewerMember[];
  markOf: (member: ViewerMember) => "keep" | "trash";
  onToggleMark?: (member: ViewerMember) => void;
  onClose: () => void;
  busy?: boolean;
  /** Show which copy is kept without offering to change it. A cleanup job settled that
   *  at scan time, and this view is for checking the answer rather than making it. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  // A pair opens straight into compare — with exactly two copies that's the only
  // thing anyone came here to do.
  const [compare, setCompare] = useState(members.length === 2);
  const [index, setIndex] = useState(0);
  const [rightIndex, setRightIndex] = useState(members.length > 1 ? 1 : 0);

  const step = useCallback((delta: number) => {
    setIndex((current) => (current + delta + members.length) % members.length);
  }, [members.length]);

  useEffect(() => {
    if (compare) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compare, step]);

  const left = members[Math.min(index, members.length - 1)];
  const right = members[Math.min(rightIndex, members.length - 1)];

  return (
    <Modal
      variant="panel"
      title={title}
      className="dup-view-modal"
      headerClassName="dup-view-header"
      onClose={onClose}
      headerAction={members.length > 1 ? (
        <Button
          variant="secondary"
          compact
          aria-pressed={compare}
          onClick={() => setCompare((current) => !current)}
        >
          {compare ? <Square size={14} aria-hidden="true" /> : <Columns2 size={14} aria-hidden="true" />}
          <span>{compare ? t("controlDash:dupes.viewOne") : t("controlDash:dupes.compareTwo")}</span>
        </Button>
      ) : undefined}
    >
      {/* One scrollable child for the panel's content row: the surface is a fixed
          grid with overflow hidden, so extra top-level children spill into an
          implicit row and get clipped at the bottom. */}
      <div className="dup-view-body">
      {compare ? (
        <>
          <div className="dup-view-compare">
            <Pane member={left} mark={markOf(left)} busy={busy} readOnly={readOnly} onToggleMark={() => onToggleMark(left)} />
            <Pane member={right} mark={markOf(right)} busy={busy} readOnly={readOnly} onToggleMark={() => onToggleMark(right)} />
          </div>
          {members.length > 2 && (
            <div className="dup-view-pickers">
              <label>
                <span>{t("controlDash:dupes.left")}</span>
                <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
                  {members.map((member, position) => (
                    <option key={member.itemId} value={position}>{fileName(member)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("controlDash:dupes.right")}</span>
                <select value={rightIndex} onChange={(event) => setRightIndex(Number(event.target.value))}>
                  {members.map((member, position) => (
                    <option key={member.itemId} value={position}>{fileName(member)}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </>
      ) : (
        <div className="dup-view-single">
          <Button
            variant="icon"
            className="dup-view-step"
            disabled={members.length < 2}
            aria-label={t("controlDash:dupes.previousCopy")}
            title={t("controlDash:dupes.previousCopy")}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </Button>
          <Pane member={left} mark={markOf(left)} busy={busy} readOnly={readOnly} onToggleMark={() => onToggleMark(left)} />
          <Button
            variant="icon"
            className="dup-view-step"
            disabled={members.length < 2}
            aria-label={t("controlDash:dupes.nextCopy")}
            title={t("controlDash:dupes.nextCopy")}
            onClick={() => step(1)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </Button>
        </div>
      )}

        <p className="dup-view-status datagrid-muted">
          {compare
            ? t("controlDash:dupes.comparingStatus", { count: members.length })
            : t("controlDash:dupes.copyStatus", { index: index + 1, count: members.length })}
        </p>
      </div>
      {/* No Close button down here. The panel header carries one, and this is a
          look-at-it surface rather than a form: there is nothing to submit, so a
          second dismissal at the far end of a full-screen comparison is one more
          thing to read past. Escape and the backdrop still close it too. */}
    </Modal>
  );
}
