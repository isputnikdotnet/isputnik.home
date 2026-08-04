import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Columns2, ExternalLink, Folder, ImageOff, Images, Square } from "lucide-react";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { formatBytes } from "../../../shared/utils";
import { TOP_LEVEL, TOP_LEVEL_HINT } from "./duplicate-shared";

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
  fileUrl: string;
  width: number | null;
  height: number | null;
  size: number | null;
}

function fileName(member: ViewerMember): string {
  return member.path.split("/").pop() || member.path;
}

function dimensions(member: ViewerMember): string {
  return member.width && member.height ? `${member.width} × ${member.height}` : "Unknown size";
}

function folderOf(member: ViewerMember): string {
  const cut = member.path.lastIndexOf("/");
  return cut === -1 ? "" : member.path.slice(0, cut);
}

// Just the folder itself, not its ancestors; the full path is on the tooltip.
// A copy in no folder reads "Top level", not "Library root" — see TOP_LEVEL.
function folderName(member: ViewerMember): string {
  const folder = folderOf(member);
  return folder ? folder.split("/").pop() || folder : TOP_LEVEL;
}

function Pane({
  member,
  mark,
  onToggleMark,
  busy
}: {
  member: ViewerMember;
  mark: "keep" | "trash";
  onToggleMark: () => void;
  busy: boolean;
}) {
  const src = member.previewUrl ?? member.coverUrl;
  return (
    <div className={`dup-view-pane${mark === "keep" ? " is-keep" : " is-trash"}`}>
      {/* The picture is the control, exactly as the tiles are on the page behind —
          one way to mark a copy, learned once. */}
      <Button
        variant="text"
        className="dup-view-stage"
        aria-pressed={mark === "trash"}
        disabled={busy}
        title={mark === "keep" ? "Marked to keep — click to delete it instead" : "Marked for deletion — click to keep it"}
        onClick={onToggleMark}
      >
        {src
          ? <img src={src} alt={fileName(member)} />
          : <span className="dup-view-missing"><ImageOff size={28} aria-hidden="true" /></span>}
        <span className="dup-view-chip" aria-hidden="true">{mark === "keep" ? "Keep" : "Delete"}</span>
      </Button>
      <div className="dup-view-meta">
        <strong title={member.path}>{fileName(member)}</strong>
        <span className="dup-view-where">
          <Images size={12} aria-hidden="true" />
          <span>{member.libraryName}</span>
        </span>
        <span className="dup-view-where" title={folderOf(member) || TOP_LEVEL_HINT}>
          <Folder size={12} aria-hidden="true" />
          <span>{folderName(member)}</span>
        </span>
        <span className="datagrid-muted">
          {dimensions(member)}{member.size != null ? ` · ${formatBytes(member.size)}` : ""}
        </span>
        <a className="dup-view-original" href={member.fileUrl} target="_blank" rel="noreferrer">
          <span>Open original</span>
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

export function DuplicateViewer({
  title,
  members,
  markOf,
  onToggleMark,
  onClose,
  busy = false
}: {
  title: string;
  members: ViewerMember[];
  markOf: (member: ViewerMember) => "keep" | "trash";
  onToggleMark: (member: ViewerMember) => void;
  onClose: () => void;
  busy?: boolean;
}) {
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
          <span>{compare ? "View one" : "Compare two"}</span>
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
            <Pane member={left} mark={markOf(left)} busy={busy} onToggleMark={() => onToggleMark(left)} />
            <Pane member={right} mark={markOf(right)} busy={busy} onToggleMark={() => onToggleMark(right)} />
          </div>
          {members.length > 2 && (
            <div className="dup-view-pickers">
              <label>
                <span>Left</span>
                <select value={index} onChange={(event) => setIndex(Number(event.target.value))}>
                  {members.map((member, position) => (
                    <option key={member.itemId} value={position}>{fileName(member)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Right</span>
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
            aria-label="Previous copy"
            title="Previous copy"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </Button>
          <Pane member={left} mark={markOf(left)} busy={busy} onToggleMark={() => onToggleMark(left)} />
          <Button
            variant="icon"
            className="dup-view-step"
            disabled={members.length < 2}
            aria-label="Next copy"
            title="Next copy"
            onClick={() => step(1)}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </Button>
        </div>
      )}

        <p className="dup-view-status datagrid-muted">
          {compare
            ? `Comparing 2 of ${members.length} copies`
            : `Copy ${index + 1} of ${members.length} — use ← and → to step through them`}
        </p>
      </div>

      {/* Outside the scrolling body, in its own row: in a short window the body
          scrolls, and an action row inside it would scroll out of reach. */}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
