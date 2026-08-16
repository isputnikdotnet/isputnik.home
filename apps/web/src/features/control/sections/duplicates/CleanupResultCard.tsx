// One card of a cleanup's snapshot — the three shapes a result comes in.
//
// Presentational: it knows nothing about loading, paging or the job. What it may do
// is handed in as three callbacks, so the page owns every request and this file owns
// every sentence.
import { useState, type ReactNode } from "react";
import {
  ArrowRight, CircleCheck, Columns2, ExternalLink, Folder, FolderOpen, FolderTree, HardDrive,
  ImageOff, Images, Trash2, TriangleAlert
} from "lucide-react";
import { formatBytes } from "../../../../shared/utils";
import { Button } from "../../../../shared/Button";
import { RiskGauge } from "../../../../shared/RiskGauge";
import { FolderStrip, TOP_LEVEL, TOP_LEVEL_HINT } from "./shared";
import { DuplicateViewer, type ViewerMember } from "./DuplicateViewer";
import { FolderCompare } from "./FolderCompare";
import { CertaintyBadge } from "./CertaintyBadge";
import {
  doomedFolder, fileNameOf, folderLabel, folderLocation, folderOfPath, galleryFolderHref,
  keeperFolders, keeperMuchSmaller, largestPixelsOf, photoCountLabel, sizeShortfallOf,
  type SnapshotFolder, type SnapshotMember, type SnapshotResult
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
  /** Move one copy of a photo set between keep and delete — the scan's guess, overruled.
   *  Photo sets only; a folder card's offer is about the folder, not its files. */
  onSetRole: (memberId: string, role: "keep" | "delete") => void;
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
 *  has nothing to show, so it is left out rather than rendered as a broken frame.
 *
 *  Takes the members rather than the result so it is handed the SAME stable order the
 *  tiles use: the viewer holds left/right positions in state, and a list that reordered
 *  under a toggle would swap the pane you were looking at. */
const viewerMembersOf = (members: SnapshotMember[]): ViewerMember[] =>
  members
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
              {result.risk && <RiskGauge severity={result.risk.severity} label={result.risk.label} explanation={result.risk.explanation} />}
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
              {result.risk && <RiskGauge severity={result.risk.severity} label={result.risk.label} explanation={result.risk.explanation} />}
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

/** One copy of a photo set, picture first.
 *
 *  The path says WHICH copy this is; only the picture says whether the copies are the
 *  same photograph — which is the entire question in the near-identical tier, and the
 *  one a list of filenames cannot answer. The tile is deliberately small: this card
 *  used to be a list precisely because a seven-copy set as seven big tiles is a wall.
 *
 *  The picture is the control: clicking it moves this copy between keep and delete,
 *  which is the decision the scan only guessed at. "Compare" opens the copies full size
 *  for anyone who wants a closer look before choosing. */
function CopyTile({ member, largestPixels, busy, onToggle }: {
  member: SnapshotMember;
  /** The set's biggest copy in pixels, for the "N× smaller" tag. 0 disables it. */
  largestPixels: number;
  busy: boolean;
  /** Absent when this copy's fate is not open to change — a cleanup someone else owns,
   *  a protected library, or a copy already in the Recycle Bin. Then the tile is a
   *  plain frame rather than a disabled button, which would promise an action that
   *  isn't merely unavailable but does not exist. */
  onToggle?: () => void;
}) {
  const doomed = member.role === "delete";
  const shortfall = sizeShortfallOf(member, largestPixels);
  // The grid thumbnail, not the web-sized preview: a card shows a dozen of these and
  // the preview is sized for the viewer's full-screen panes.
  const src = member.coverUrl ?? member.previewUrl;
  const folder = folderOfPath(member.path);
  const badge = member.role === "keep" ? "Keep" : member.role === "protected" ? "Protected" : "Delete";
  // alt="" — the filename is written underneath, and the picture itself is not
  // describable here. A copy whose photo has gone shows the empty frame rather than a
  // broken image: the snapshot outlives what it describes.
  const picture = src
    ? <img src={src} alt="" loading="lazy" />
    : <ImageOff size={22} aria-hidden="true" />;

  return (
    <li className={`dup-copy${doomed ? " is-trash" : " is-keep"}`}>
      {onToggle ? (
        // Labelled by what the click DOES, not by the state it is in: "Keep IMG_1109
        // instead" is unambiguous where a pressed/unpressed toggle over two words that
        // both mean an outcome is not.
        <Button
          variant="text"
          className="dup-copy-thumb"
          disabled={busy}
          aria-label={`${doomed ? "Keep" : "Delete"} ${fileNameOf(member.path)} instead`}
          title={doomed
            ? "Marked for deletion — click to keep it instead"
            : "Marked to keep — click to delete it instead"}
          onClick={onToggle}
        >
          {picture}
        </Button>
      ) : (
        <span className="dup-copy-thumb is-static">{picture}</span>
      )}
      {/* Readable, not aria-hidden like the folder tiles' badge: there, "Delete this"
          on the button says what happens. Here the badge is the ONLY thing that says
          which of these copies is the one leaving. */}
      <span className="dup-copy-badge">{badge}</span>
      <span className="dup-copy-info">
        <strong className="dup-copy-name" title={member.path}>{fileNameOf(member.path)}</strong>
        <span className="dup-copy-where" title={folder || TOP_LEVEL_HINT}>
          <Folder size={11} aria-hidden="true" />
          <span>{folder || TOP_LEVEL}</span>
        </span>
        <span className="dup-copy-where" title={`In the library “${member.libraryName}”`}>
          <Images size={11} aria-hidden="true" />
          <span>{member.libraryName}</span>
        </span>
        <span className="dup-copy-where">
          {formatBytes(member.size ?? 0)}
          {member.width && member.height ? ` · ${member.width}×${member.height}` : ""}
        </span>
        {/* The tag is a fact on a copy being deleted and a warning on one being kept:
            deleting the small copy is the point of the page, keeping it is the mistake.
            Severity shows as colour, not more words — the number already says it. */}
        {shortfall && (
          <span
            className={`dup-copy-scale${!doomed ? " is-warn" : shortfall.severe ? " is-much" : ""}`}
            title={`This copy has ${shortfall.times}× fewer pixels than the biggest one in the set${
              !doomed ? " — and it is the one being kept" : ""
            }.`}
          >
            {!doomed && <TriangleAlert size={11} aria-hidden="true" />}
            {shortfall.label}
          </span>
        )}
      </span>
    </li>
  );
}

function PhotoSetCard({
  result, canWork, actions
}: {
  result: SnapshotResult;
  canWork: boolean;
  actions: CleanupResultActions;
}) {
  // Ordered by PATH, and deliberately not by role.
  //
  // Kept copies used to lead, which meant a tile jumped to the front of the row the
  // instant you clicked it and to the back when you changed your mind — so the copy you
  // had just decided about was never where you left it, and on a seven-copy set the
  // whole row reshuffled under the cursor. A path never changes, so a tile now holds its
  // place for the life of the card and only its badge moves.
  const ordered = [...result.members].sort((a, b) => a.path.localeCompare(b.path));
  const keeps = result.members.filter((member) => member.role === "keep");
  // The set's name, from its first copy rather than from whichever copy is kept — the
  // heading has no business changing because a badge did.
  const titleMember = ordered[0];
  const near = result.tier === "near";
  const [viewing, setViewing] = useState(false);
  const viewable = viewerMembersOf(ordered);

  /** Whether this copy's fate is still open. Protection belongs to the library and a
   *  copy already in the Recycle Bin is past deciding. Every other copy is free to move
   *  either way, in any combination — one click changes one photo and nothing else. */
  const togglable = (member: SnapshotMember) =>
    canWork && member.role !== "protected" && member.status !== "deleted";

  // Nothing kept. Allowed — a set of copies of something nobody wants is a real answer
  // — but it is no longer "remove the spares": the picture itself leaves the library.
  // Said in the card's own voice, because the Delete button beside it still reads
  // "Delete copies" and a person is entitled to know this one takes the last one too.
  const keepsNothing = keeps.length === 0
    && result.members.some((member) => member.role === "delete" && member.status !== "deleted");

  // For the "N× smaller" tags, and the warning below when the small copy is the one
  // being kept. Recomputed on every role flip, which is exactly when it matters: the
  // scan no longer proposes keeping a preview, but a click can.
  const largestPixels = near ? largestPixelsOf(result.members) : 0;
  const keepingSmall = near && keeperMuchSmaller(result.members);

  return (
    <div className="dup-set">
      <div className="dup-set-head">
        <div className="dup-set-summary">
          <h3 className="dup-set-title">{titleMember && fileNameOf(titleMember.path)}</h3>
          <p className="dup-set-meta datagrid-muted">
            <span><Images size={14} aria-hidden="true" /> {result.members.length} copies</span>
            <span><HardDrive size={14} aria-hidden="true" /> {formatBytes(result.reclaimableBytes)}</span>
            {result.risk && <RiskGauge severity={result.risk.severity} label={result.risk.label} explanation={result.risk.explanation} />}
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
          {keepsNothing && (
            <p className="dup-set-explain dup-set-near">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                Nothing here is kept, so this removes the picture from your library, not
                just its spare copies. {result.members.length === 1 ? "The copy goes" : "All copies go"} to
                the Recycle Bin, where {result.members.length === 1 ? "it can" : "they can"} still be restored.
              </span>
            </p>
          )}
          {keepingSmall && (
            <p className="dup-set-explain dup-set-near">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>
                A copy being deleted is much larger than the one being kept. Pixels can't be
                got back — check you're keeping the right one.
              </span>
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
      {/* Deliberately NOT wrapped in .dup-set-body: that is the folder card's two-column
          body (strip beside folders), and it pinned this content into a 270px column
          with half the card standing empty. */}
      <ul className="dup-copies">
        {/* Every tile carries its size and dimensions. On a near set they are the
            visible difference between the copies; on an identical set they are the
            same on every tile, and that sameness is itself the reassurance — it
            SHOWS the copies are interchangeable instead of asking to be believed. */}
        {ordered.map((member) => (
          <CopyTile
            key={member.id}
            member={member}
            largestPixels={largestPixels}
            busy={actions.busy}
            onToggle={togglable(member)
              ? () => actions.onSetRole(member.id, member.role === "delete" ? "keep" : "delete")
              : undefined}
          />
        ))}
      </ul>

      {viewing && (
        <DuplicateViewer
          title={near
            ? `${viewable.length} near-identical copies — check them before deleting`
            : `${viewable.length} copies of the same photo`}
          members={viewable}
          // Full size is where a near-identical pair is actually settled, so the panes
          // toggle the same way the tiles do rather than showing an answer you have to
          // close the panel to argue with. Read-only only when the cleanup is somebody
          // else's — then there is no decision here to make.
          readOnly={!canWork}
          busy={actions.busy}
          markOf={(member) =>
            result.members.find((row) => row.itemId === member.itemId)?.role === "delete" ? "trash" : "keep"}
          onToggleMark={(member) => {
            const row = result.members.find((entry) => entry.itemId === member.itemId);
            if (row && togglable(row)) actions.onSetRole(row.id, row.role === "delete" ? "keep" : "delete");
          }}
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
