// One card of a cleanup's snapshot — the three shapes a result comes in.
//
// Presentational: it knows nothing about loading, paging or the job. What it may do
// is handed in as three callbacks, so the page owns every request and this file owns
// every sentence.
import { useState, type ReactNode } from "react";
import {
  ArrowRight, CircleCheck, Columns2, ExternalLink, FolderOpen, FolderTree, HardDrive, Images,
  Trash2, TriangleAlert
} from "lucide-react";
import { formatBytes } from "../../../../shared/utils";
import { Button } from "../../../../shared/Button";
import { FolderStrip } from "./shared";
import { DuplicateViewer, type ViewerMember } from "./DuplicateViewer";
import { FolderCompare } from "./FolderCompare";
import { CertaintyBadge } from "./CertaintyBadge";
import {
  doomedFolder, folderLabel, folderLocation, galleryFolderHref, keeperFolders, photoCountLabel,
  type SnapshotFolder, type SnapshotResult
} from "./cleanup-types";

function CleanupFolderTile({
  folder, keep, position, badge, note
}: {
  folder: SnapshotFolder;
  keep: boolean;
  position: number;
  badge: string;
  note?: ReactNode;
}) {
  return (
    <div className="dup-set-folder-wrap">
      {position > 0 && <ArrowRight className="dup-set-arrow" size={18} aria-hidden="true" />}
      <div className={`dup-set-folder${keep ? " is-keep" : " is-trash"}`}>
        <div className="dup-set-folder-top">
          <span className="dup-copy-badge dup-set-badge" aria-hidden="true">{badge}</span>
          {/* Opens in a new tab on purpose: this is a page you are working THROUGH,
              and navigating away from a cleanup mid-review to go and look at a
              folder loses your place in it. */}
          <a
            className="dup-set-open"
            href={galleryFolderHref(folder)}
            target="_blank"
            rel="noreferrer"
            title={`Open “${folderLabel(folder)}” in the gallery, in a new tab`}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span className="sr-only">Open {folderLabel(folder)} in the gallery</span>
          </a>
        </div>
        <span className="dup-set-name-row">
          <FolderOpen size={17} aria-hidden="true" />
          <strong className="dup-set-folder-name">{folderLabel(folder)}</strong>
        </span>
        {/* Three facts, three icons — so they are told apart at a glance instead of
            read in order. Each icon holds the left edge while its text wraps beside
            it, which is what keeps a long path from starting under its own glyph. */}
        <span className="dup-set-path" title={folderLocation(folder)}>
          <FolderTree size={12} aria-hidden="true" />
          <span>{folderLocation(folder)}</span>
        </span>
        {/* Which library, not when it was added. A card can compare two folders in
            different libraries, and then the library is the difference between them
            — the one thing you cannot work out from the name and path above. The
            date was true and answered a question nobody was asking here. */}
        <span className="dup-set-line" title={`In the library “${folder.libraryName}”`}>
          <Images size={12} aria-hidden="true" />
          <span>{folder.libraryName}</span>
        </span>
        <span className="dup-set-line" title={`${photoCountLabel(folder.itemCount)}, ${formatBytes(folder.bytes)}`}>
          <HardDrive size={12} aria-hidden="true" />
          <span>{formatBytes(folder.bytes)}</span>
        </span>
        {note && <span className="dup-set-line dup-set-note">{note}</span>}
      </div>
    </div>
  );
}

/** What the page lets this card do. Every one is a request the page makes and
 *  reloads from; the card only ever asks. */
export interface CleanupResultActions {
  /** True while any action on the page is in flight — every button goes quiet. */
  busy: boolean;
  /** True while THIS card's own action is the one running. */
  running: boolean;
  onSkip: () => void;
  onDismiss: () => void;
  onDelete: () => void;
}

function ReviewButtons({
  result, actions, deleteLabel, className, deleteClassName, deleteIcon = false, leading
}: {
  result: SnapshotResult;
  actions: CleanupResultActions;
  deleteLabel: string;
  className: string;
  deleteClassName: string;
  deleteIcon?: boolean;
  /** Rendered first, in the SAME row. A slot rather than a wrapper: nesting a second
   *  row inside this one squeezed all three buttons into one column's width and pushed
   *  Delete off the card. */
  leading?: ReactNode;
}) {
  const deletable = result.members.some((member) => member.role === "delete" && member.status !== "deleted");
  const label = actions.running ? "Deleting…" : deleteLabel;
  return (
    <div className={className}>
      {leading}
      <Button
        variant="secondary"
        compact
        disabled={actions.busy}
        title="Take it off this cleanup. The next one will offer it again."
        onClick={actions.onSkip}
      >
        {result.reviewStatus === "skipped" ? "Put back" : "Skip"}
      </Button>
      <Button
        variant="secondary"
        compact
        disabled={actions.busy}
        title="These are not duplicates. No future scan will pair them again."
        onClick={actions.onDismiss}
      >
        Not the same
      </Button>
      <Button
        variant="secondary"
        danger
        compact
        className={deleteClassName}
        disabled={actions.busy || !deletable}
        onClick={actions.onDelete}
      >
        {deleteIcon ? <><Trash2 size={14} /><span>{label}</span></> : label}
      </Button>
    </div>
  );
}

/** The copies of a set, as the viewer wants them. A member whose photo has since gone
 *  has nothing to show, so it is left out rather than rendered as a broken frame. */
const viewerMembersOf = (result: SnapshotResult): ViewerMember[] =>
  result.members
    .filter((member) => member.itemId !== null)
    .map((member) => ({
      itemId: member.itemId!,
      libraryName: member.libraryName,
      path: member.path,
      coverUrl: member.coverUrl,
      previewUrl: member.previewUrl,
      fileUrl: member.fileUrl,
      width: member.width,
      height: member.height,
      size: member.size
    }));

/** The folder equivalent: every photo of one folder against its counterpart in the
 *  other. Same reasoning as the copy viewer — a decision about a whole folder deserves
 *  more than a count and four thumbnails — and available to anyone who can see the job. */
function CompareFoldersButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button variant="secondary" compact onClick={onOpen} title="See both folders' photos side by side">
      <Columns2 size={14} aria-hidden="true" />
      <span>Compare</span>
    </Button>
  );
}

/** Open the copies full size. Always available, even to someone who may not act on the
 *  set: looking is not an action, and a near-identical pair is exactly the case where
 *  the thumbnails on the card cannot answer the question. */
function LookButton({ onOpen, count }: { onOpen: () => void; count: number }) {
  return (
    <Button
      variant="secondary"
      compact
      onClick={onOpen}
      title={count === 2 ? "See both copies full size, side by side" : "See these copies full size"}
    >
      <Columns2 size={14} aria-hidden="true" />
      <span>Compare</span>
    </Button>
  );
}

const ReviewedBadge = ({ result }: { result: SnapshotResult }) =>
  result.reviewStatus === "unreviewed" ? null : (
    <span>
      <CircleCheck size={14} aria-hidden="true" /> {result.reviewStatus === "skipped" ? "Skipped" : "Looked at"}
    </span>
  );

// One card, one destination. A folder whose photos survive in three different places
// produces three of these rather than one card listing three folders — "this folder
// against that folder" is how a person reads a card, and a list of destinations gets
// read as "these folders duplicate each other", which is a different and wrong
// statement.
function ContainedCard({
  result, canWork, actions
}: {
  result: SnapshotResult;
  canWork: boolean;
  actions: CleanupResultActions;
}) {
  const [comparing, setComparing] = useState(false);
  const going = doomedFolder(result);
  const keeper = keeperFolders(result)[0];
  const doomedCount = result.members.filter((member) => member.role === "delete").length;
  const totalPhotos = going?.itemCount ?? doomedCount;
  const otherLibrary = keeper && going && keeper.libraryName !== going.libraryName
    ? ` in ${keeper.libraryName}`
    : "";

  return (
    <div className="dup-set dup-folder-card dup-cleanup-folder-card">
      <div className="dup-folder-card-main">
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">“{going ? folderLabel(going) : ""}”</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {photoCountLabel(totalPhotos)}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
              <ReviewedBadge result={result} />
            </p>
            <CertaintyBadge match={result.matchConfidence} keeper={result.keeperConfidence} />
                        {/* One plain sentence, because the card is one plain comparison. */}
            <p className="dup-set-explain datagrid-muted">
              {totalPhotos === 1 ? "This photo" : `These ${totalPhotos} photos`} also
              {totalPhotos === 1 ? " sits" : " sit"} in “{keeper ? folderLabel(keeper) : ""}”{otherLibrary}.
            </p>
          </div>
        </div>
        <FolderStrip urls={result.coverUrls ?? []} total={totalPhotos} />
      </div>

      <div className="dup-folder-card-decision">
        {canWork ? (
          <ReviewButtons
            result={result}
            actions={actions}
            deleteLabel="Delete this"
            className="dup-folder-card-actions"
            deleteClassName="dup-set-delete-action"
            leading={<CompareFoldersButton onOpen={() => setComparing(true)} />}
          />
        ) : (
          <div className="dup-folder-card-actions">
            <CompareFoldersButton onOpen={() => setComparing(true)} />
          </div>
        )}
        <div className="dup-set-folders">
          {keeper && (
            <CleanupFolderTile
              key={`${keeper.libraryId}:${keeper.folderPath}`}
              folder={keeper}
              keep
              position={0}
              badge={keeper.role === "protected" ? "Protected" : "Keep"}
            />
          )}
          {going && (
            <CleanupFolderTile
              folder={going}
              keep={false}
              position={1}
              badge="Delete"
            />
          )}
        </div>
      </div>

      {comparing && <FolderCompare result={result} onClose={() => setComparing(false)} />}
    </div>
  );
}

function FolderSetCard({
  result, canWork, actions
}: {
  result: SnapshotResult;
  canWork: boolean;
  actions: CleanupResultActions;
}) {
  const kept = result.folders.find((folder) => folder.role === "keep");
  const going = result.folders.filter((folder) => folder.role !== "keep");
  const deleteFolders = going.filter((folder) => folder.role === "delete");
  const titleFolder = kept ?? going[0];

  // An overlap is a narrower act than a folder set, and the card has to say so or it
  // reads as "this folder is going". BOTH folders stay: only the pictures they hold in
  // common leave one side, and everything either holds alone is untouched. So the
  // counts are of the SHARED photos, the tile says what leaves rather than that the
  // folder does, and the button names the number.
  const [comparing, setComparing] = useState(false);
  const overlap = result.type === "overlap";
  const shared = going[0]?.itemCount ?? result.members.filter((member) => member.role === "delete").length;
  const totalPhotos = overlap ? shared : (kept?.itemCount ?? going[0]?.itemCount ?? result.members.length);
  const deleteLabel = overlap
    ? `Delete ${shared} shared cop${shared === 1 ? "y" : "ies"}`
    : deleteFolders.length === 1 ? "Delete this" : "Delete copies";

  return (
    <div className="dup-set dup-folder-card dup-cleanup-folder-card">
      <div className="dup-folder-card-main">
        <div className="dup-set-head">
          <div className="dup-set-summary">
            <h3 className="dup-set-title">“{titleFolder ? folderLabel(titleFolder) : ""}”</h3>
            <p className="dup-set-meta datagrid-muted">
              <span><Images size={14} aria-hidden="true" /> {photoCountLabel(totalPhotos)}</span>
              <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
              <ReviewedBadge result={result} />
            </p>
            <CertaintyBadge match={result.matchConfidence} keeper={result.keeperConfidence} />
                        {overlap && (
              <p className="dup-set-explain datagrid-muted">
                Both folders stay. Only these {photoCountLabel(shared)} — the ones they hold in common — leave
                “{going[0] ? folderLabel(going[0]) : ""}”. Anything either folder has on its own is untouched.
              </p>
            )}
            {result.keeperReason && (
              <p className="dup-set-explain datagrid-muted">Kept because: {result.keeperReason}</p>
            )}
          </div>
        </div>
        <FolderStrip urls={result.coverUrls ?? []} total={totalPhotos} />
      </div>

      <div className="dup-folder-card-decision">
        {canWork ? (
          <ReviewButtons
            result={result}
            actions={actions}
            deleteLabel={deleteLabel}
            className="dup-folder-card-actions"
            deleteClassName="dup-set-delete-action"
            leading={<CompareFoldersButton onOpen={() => setComparing(true)} />}
          />
        ) : (
          <div className="dup-folder-card-actions">
            <CompareFoldersButton onOpen={() => setComparing(true)} />
          </div>
        )}
        <div className="dup-set-folders">
          {kept && (
            <CleanupFolderTile
              folder={kept}
              keep
              position={0}
              badge={overlap ? "Keeps its copies" : "Keep"}
            />
          )}
          {going.map((folder, index) => (
            <CleanupFolderTile
              key={`${folder.libraryId}:${folder.folderPath}`}
              folder={folder}
              keep={folder.role === "protected"}
              position={(kept ? 1 : 0) + index}
              badge={folder.role === "protected" ? "Protected" : overlap ? "Loses its copies" : "Delete"}
            />
          ))}
        </div>
      </div>

      {comparing && <FolderCompare result={result} onClose={() => setComparing(false)} />}
    </div>
  );
}

function PhotoSetCard({
  result, canWork, actions
}: {
  result: SnapshotResult;
  canWork: boolean;
  actions: CleanupResultActions;
}) {
  const keep = result.members.find((member) => member.role === "keep");
  const going = result.members.filter((member) => member.role !== "keep");
  const near = result.tier === "near";
  const [viewing, setViewing] = useState(false);
  const viewable = viewerMembersOf(result);

  return (
    <div className="dup-set">
      <div className="dup-set-head">
        <div className="dup-set-summary">
          <h3 className="dup-set-title">{keep?.path.split("/").pop()}</h3>
          <p className="dup-set-meta datagrid-muted">
            <span><Images size={14} aria-hidden="true" /> {result.members.length} copies</span>
            <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
          </p>
          <CertaintyBadge match={result.matchConfidence} keeper={result.keeperConfidence} />
          {/* Said on the card as well as under the heading. Someone working down a long
              page acts card by card, and "these are not the same file" is the one thing
              that must not be left three screens up. */}
          {near && (
            <p className="dup-set-explain dup-set-near">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>These only look alike. They may be two different shots — check before deleting.</span>
            </p>
          )}
          {result.keeperReason && (
            <p className="dup-set-explain datagrid-muted">Kept because: {result.keeperReason}</p>
          )}
        </div>
        {canWork ? (
          <ReviewButtons
            result={result}
            actions={actions}
            deleteLabel="Delete copies"
            className="dup-group-actions"
            deleteClassName="dup-delete-action"
            deleteIcon
            leading={viewable.length > 1 ? <LookButton count={viewable.length} onOpen={() => setViewing(true)} /> : null}
          />
        ) : viewable.length > 1 && (
          <div className="dup-group-actions">
            <LookButton count={viewable.length} onOpen={() => setViewing(true)} />
          </div>
        )}
      </div>
      <div className="dup-set-body">
        <ul className="dup-member-list">
          {/* On a near set the file sizes are the visible difference between the copies
              — which is the downscaled one, which is the original — so they are worth
              the column. In an identical set every size is the same by definition and
              printing them would be noise. */}
          {keep && (
            <li className="dup-member-row is-keep">
              <span className="dup-copy-badge" aria-hidden="true">Keep</span>
              <span className="dup-member-path">{keep.path}</span>
              {near && <span className="datagrid-muted">{formatBytes(keep.size ?? 0)}</span>}
              <span className="datagrid-muted">{keep.libraryName}</span>
            </li>
          )}
          {going.map((member) => (
            <li className={`dup-member-row ${member.role === "protected" ? "is-keep" : "is-trash"}`} key={member.id}>
              <span className="dup-copy-badge" aria-hidden="true">
                {member.role === "protected" ? "Protected" : "Delete"}
              </span>
              <span className="dup-member-path">{member.path}</span>
              {near && <span className="datagrid-muted">{formatBytes(member.size ?? 0)}</span>}
              <span className="datagrid-muted">{member.libraryName}</span>
            </li>
          ))}
        </ul>
      </div>

      {viewing && (
        <DuplicateViewer
          title={near
            ? `${viewable.length} near-identical copies — check them before deleting`
            : `${viewable.length} copies of the same photo`}
          members={viewable}
          // The scan settled which copy survives, so this shows the answer rather than
          // offering to change it. Skip or "Not the same" on the card are the ways to
          // disagree with it.
          readOnly
          markOf={(member) =>
            result.members.find((row) => row.itemId === member.itemId)?.role === "delete" ? "trash" : "keep"}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

/** An overlap reads as a folder set — two folders, one keeping its copies — so it
 *  shares that card rather than getting a fourth one nobody has seen yet. */
export function CleanupResultCard({
  result, canWork, actions
}: {
  result: SnapshotResult;
  canWork: boolean;
  actions: CleanupResultActions;
}) {
  if (result.type === "contained") return <ContainedCard result={result} canWork={canWork} actions={actions} />;
  if (result.type === "folder_set" || result.type === "overlap") {
    return <FolderSetCard result={result} canWork={canWork} actions={actions} />;
  }
  return <PhotoSetCard result={result} canWork={canWork} actions={actions} />;
}
