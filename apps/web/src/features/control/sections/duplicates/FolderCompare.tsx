// Two folders, side by side, scrolling as one surface — so a decision about a whole
// folder can be made on the pictures rather than on a count and four thumbnails.
//
// The pairing is already in the data and costs nothing to render: every doomed file's
// `keeperMemberId` points at the copy that survives it, so each ROW of this view is one
// member pair. No matching at render time, no guessing from filenames.
//
// Review only. The scan settled which side keeps, and disagreeing with it is what Skip
// and "Not the same" on the card are for — an action surface here would have to
// re-implement the revalidation that makes deleting safe.
import { useMemo, useState } from "react";
import { Folder, ImageOff, Images } from "lucide-react";
import { Modal } from "../../../../shared/Modal";
import { Button } from "../../../../shared/Button";
import { SelectMenu } from "../../../../shared/SelectMenu";
import { formatBytes } from "../../../../shared/utils";
import { folderLabel, type SnapshotFolder, type SnapshotMember, type SnapshotResult } from "./cleanup-types";

const fileName = (path: string): string => path.split("/").pop() || path;

const dimensions = (member: SnapshotMember): string =>
  member.width && member.height ? `${member.width} × ${member.height}` : "";

function Cell({ member, side }: { member: SnapshotMember | null; side: "keep" | "going" }) {
  if (!member) {
    // Nothing opposite: this photo is in one folder and not the other. Said plainly
    // rather than left as a gap, which reads as a rendering fault.
    return (
      <div className="dup-compare-cell is-empty">
        <span className="datagrid-muted">Not in this folder</span>
      </div>
    );
  }
  const src = member.coverUrl ?? member.previewUrl;
  return (
    <div className={`dup-compare-cell is-${side}`}>
      <div className="dup-compare-thumb">
        {/* Lazy on purpose: a folder can hold thousands, and this view exists precisely
            for the big ones. The browser fetches what scrolls into range. */}
        {src
          ? <img src={src} alt={fileName(member.path)} loading="lazy" decoding="async" />
          : <span className="dup-compare-missing"><ImageOff size={20} aria-hidden="true" /></span>}
      </div>
      <div className="dup-compare-facts">
        <strong title={member.path}>{fileName(member.path)}</strong>
        <span className="datagrid-muted">
          {[dimensions(member), member.size != null ? formatBytes(member.size) : ""]
            .filter(Boolean).join(" · ")}
        </span>
      </div>
    </div>
  );
}

function FolderHead({ folder, side }: { folder: SnapshotFolder | undefined; side: "keep" | "going" }) {
  if (!folder) return <div className="dup-compare-head" />;
  return (
    <div className={`dup-compare-head is-${side}`}>
      {/* Its own badge, not .dup-copy-badge: that one is positioned to sit OVER a
          thumbnail, and reusing it here laid it across the folder name. */}
      <span className="dup-compare-badge">{side === "keep" ? "Keeping" : "Going"}</span>
      <span className="dup-compare-head-name">
        <Folder size={15} aria-hidden="true" />
        <strong title={folder.folderPath || "/"}>{folderLabel(folder)}</strong>
      </span>
      <span className="datagrid-muted">
        <Images size={12} aria-hidden="true" /> {folder.libraryName}
      </span>
    </div>
  );
}

export function FolderCompare({ result, onClose }: { result: SnapshotResult; onClose: () => void }) {
  const keepFolder = result.folders.find((folder) => folder.role !== "delete");
  const goingFolders = result.folders.filter((folder) => folder.role === "delete");
  const [goingId, setGoingId] = useState(goingFolders[0]?.id ?? "");
  const going = goingFolders.find((folder) => folder.id === goingId) ?? goingFolders[0];

  const rows = useMemo(() => {
    const byId = new Map(result.members.map((member) => [member.id, member]));
    // Driven from the side that is LEAVING: every file about to go, and what it hands
    // its place to. A keeper with nothing pointing at it is a photo the other folder
    // simply does not have, and that is the "Not in this folder" case below.
    const doomed = result.members
      .filter((member) => member.folderId === going?.id)
      .sort((a, b) => a.path.localeCompare(b.path));
    const paired = doomed.map((member) => ({
      key: member.id,
      keep: member.keeperMemberId ? byId.get(member.keeperMemberId) ?? null : null,
      going: member
    }));

    const spokenFor = new Set(paired.map((row) => row.keep?.id).filter(Boolean));
    const unpaired = result.members
      .filter((member) => member.folderId === keepFolder?.id && !spokenFor.has(member.id))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((member) => ({ key: member.id, keep: member, going: null }));

    return [...paired, ...unpaired];
  }, [result.members, going?.id, keepFolder?.id]);

  const pairs = rows.filter((row) => row.keep && row.going).length;

  return (
    <Modal
      variant="panel"
      title={`“${keepFolder ? folderLabel(keepFolder) : ""}” against “${going ? folderLabel(going) : ""}”`}
      subtitle={`${pairs} photo${pairs === 1 ? "" : "s"} the two hold in common`}
      className="dup-compare-modal"
      onClose={onClose}
      headerAction={goingFolders.length > 1 ? (
        <SelectMenu
          value={goingId}
          options={goingFolders.map((folder) => ({ value: folder.id, label: folderLabel(folder) }))}
          label="Folder to compare against"
          onChange={setGoingId}
        />
      ) : undefined}
    >
      <div className="dup-compare-body">
        {/* One scrolling surface holding both columns, not two panes side by side:
            row N on the left has to stay opposite row N on the right, and two
            independently scrolling lists cannot promise that. */}
        <div className="dup-compare-grid">
          <FolderHead folder={keepFolder} side="keep" />
          <FolderHead folder={going} side="going" />
          {rows.map((row) => (
            <div className="dup-compare-row" key={row.key}>
              <Cell member={row.keep} side="keep" />
              <Cell member={row.going} side="going" />
            </div>
          ))}
        </div>
        {rows.length === 0 && (
          <p className="management-empty">This result records no files to compare.</p>
        )}
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
