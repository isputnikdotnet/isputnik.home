// What the Duplicate photos and Duplicate folders pages have in common: the payload
// they both load, the folder vocabulary they both work in, and the two pickers that
// vocabulary drives — "which folders to work on" and "where to keep photos".
//
// Both pages read the SAME endpoint. It answers in one round trip and the two views
// are different cuts of one scan, so splitting it would mean two requests describing
// the same state — and a page that could disagree with its neighbour about what the
// last scan found.
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";

export interface DuplicateMember {
  itemId: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string;
  width: number | null;
  height: number | null;
  size: number | null;
  takenAt: string | null;
  camera: string | null;
  linkCount: number;
  isKeeper: boolean;
}

export interface DuplicateGroup {
  id: string;
  kind: "exact" | "near";
  keeperItemId: string | null;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  reclaimableBytes: number;
  members: DuplicateMember[];
}

// A folder has no id of its own — it exists as (library, path), and that pair is what
// every action names.
export interface DuplicateFolderMember {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  name: string;
  itemCount: number;
  bytes: number;
  linkCount: number;
  coverUrls: string[];
  isKeeper: boolean;
}

export interface DuplicateFolderGroup {
  id: string;
  itemCount: number;
  copyBytes: number;
  reclaimableBytes: number;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  members: DuplicateFolderMember[];
}

export interface ContainedFolderRef {
  libraryId: string;
  folderPath: string;
  libraryName: string;
  name: string;
}

/** One folder whose every photo also sits in `target` — most often a folder copied
 *  into itself, which no equal-contents test can ever see. */
export interface ContainedFolder {
  id: string;
  folder: ContainedFolderRef;
  target: ContainedFolderRef;
  itemCount: number;
  bytes: number;
  extraCount: number;
  coverUrls: string[];
  linkCount: number;
}

export type FolderPreferenceMode = "keep" | "clear";

/** A standing instruction attached to a folder: keep copies here, or let them go. */
export interface FolderPreference {
  libraryId: string;
  folderPath: string;
  mode: FolderPreferenceMode;
}

export interface DuplicateLibraryOption {
  id: string;
  name: string;
  candidateCount: number;
  pendingCount: number;
}

export interface DuplicatePayload {
  groups: DuplicateGroup[];
  folderGroups: DuplicateFolderGroup[];
  containedFolders: ContainedFolder[];
  folderPreferences: FolderPreference[];
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

export const EMPTY_PAYLOAD: DuplicatePayload = {
  groups: [], folderGroups: [], containedFolders: [], folderPreferences: [],
  lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
  scanning: false, reclaimableBytes: 0, libraries: []
};

// A response missing a field would throw during render and blank the whole app rather
// than just a panel, so every list degrades to empty instead.
export function normalisePayload(next: Partial<DuplicatePayload>): DuplicatePayload {
  return {
    groups: next.groups ?? [],
    folderGroups: next.folderGroups ?? [],
    containedFolders: next.containedFolders ?? [],
    folderPreferences: next.folderPreferences ?? [],
    lastScanAt: next.lastScanAt ?? null,
    candidateCount: next.candidateCount ?? 0,
    scanning: next.scanning ?? false,
    reclaimableBytes: next.reclaimableBytes ?? 0,
    pendingCount: next.pendingCount ?? 0,
    staleCount: next.staleCount ?? 0,
    libraries: next.libraries ?? []
  };
}

export const folderKey = (member: { libraryId: string; folderPath: string }): string =>
  `${member.libraryId} ${member.folderPath}`;

export const folderPathLabel = (member: { folderPath: string }): string =>
  member.folderPath || "Library root";

// The folder holding a copy, relative to its library. "" is the library root.
export function folderOf(member: DuplicateMember): string {
  const cut = member.path.lastIndexOf("/");
  return cut === -1 ? "" : member.path.slice(0, cut);
}

// A folder covers a path when it is that path or an ancestor of it — the rule both the
// filter and the keeper preference use, so picking "2017-12-10" means the folder and
// everything under it.
export function folderCovers(
  folder: { libraryId: string; folderPath: string },
  libraryId: string,
  path: string
): boolean {
  if (folder.libraryId !== libraryId) return false;
  return folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`);
}

// Every folder a duplicate was actually found in, with how many sets touch it. This is
// the whole vocabulary both pickers work in: offering a full folder tree would list
// thousands of folders with nothing duplicated in them.
export interface FolderOption {
  key: string;
  libraryId: string;
  libraryName: string;
  folderPath: string;
  setCount: number;
}

export function folderOptionsFrom(payload: DuplicatePayload): FolderOption[] {
  const options = new Map<string, FolderOption>();
  const note = (libraryId: string, libraryName: string, folderPath: string) => {
    const key = folderKey({ libraryId, folderPath });
    const existing = options.get(key);
    if (existing) existing.setCount += 1;
    else options.set(key, { key, libraryId, libraryName, folderPath, setCount: 1 });
  };

  for (const group of payload.groups) {
    // Count a folder once per set, however many copies of the set live in it.
    const seen = new Set<string>();
    for (const member of group.members) {
      const key = folderKey({ libraryId: member.libraryId, folderPath: folderOf(member) });
      if (seen.has(key)) continue;
      seen.add(key);
      note(member.libraryId, member.libraryName, folderOf(member));
    }
  }
  for (const group of payload.folderGroups) {
    for (const member of group.members) note(member.libraryId, member.libraryName, member.folderPath);
  }
  for (const row of payload.containedFolders) {
    note(row.folder.libraryId, row.folder.libraryName, row.folder.folderPath);
    note(row.target.libraryId, row.target.libraryName, row.target.folderPath);
  }

  return [...options.values()].sort((a, b) =>
    a.libraryName.localeCompare(b.libraryName) || a.folderPath.localeCompare(b.folderPath));
}

// The warning both pages open with. This is machinery that proposes deleting
// photographs; say so before anything else on the page.
export function ExperimentalNotice() {
  return (
    <MessageBox tone="warning" title="Experimental — check before you delete">
      Duplicate detection is new and still being proven. Look at what a set actually contains before removing anything,
      and start with a few sets rather than the bulk actions. Everything removed here goes to the Recycle Bin and can
      be restored until you empty it — but the safest order is check, test, and check again.
    </MessageBox>
  );
}

function FolderChoiceList({
  options,
  selected,
  disabled,
  showCounts,
  onToggle
}: {
  options: FolderOption[];
  selected: string[];
  disabled?: boolean;
  showCounts?: boolean;
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <div className="dup-folder-picker">
      {options.map((option) => (
        <label className="dup-folder-choice" key={option.key}>
          <input
            type="checkbox"
            checked={selected.includes(option.key)}
            disabled={disabled}
            onChange={(event) => onToggle(option.key, event.target.checked)}
          />
          <span className="dup-folder-choice-body">
            <strong>{option.folderPath || "Library root"}</strong>
            <span className="datagrid-muted">
              {option.libraryName}
              {showCounts ? ` · ${option.setCount} set${option.setCount === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** "Which folders to work on" — narrows the page, saves nothing, deletes nothing. */
export function FolderFilterModal({
  options,
  selected,
  onChange,
  onClose
}: {
  options: FolderOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Which folders to work on" onClose={onClose}>
      <p className="datagrid-muted dup-picker-note">
        Only folders something duplicated was actually found in are listed. Choosing some narrows the page to sets
        with a copy in them — a folder covers everything below it. Nothing is deleted or changed by this.
      </p>
      <FolderChoiceList
        options={options}
        selected={selected}
        showCounts
        onToggle={(key, checked) => onChange(checked ? [...selected, key] : selected.filter((k) => k !== key))}
      />
      <div className="modal-actions">
        <Button variant="text" disabled={selected.length === 0} onClick={() => onChange([])}>Clear</Button>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/** How a folder is marked in the picker while it's being edited. */
export type PreferenceDraft = Record<string, FolderPreferenceMode>;

const MODES: { value: FolderPreferenceMode | ""; label: string; hint: string }[] = [
  { value: "keep", label: "Keep here", hint: "When copies are in several places, keep this one" },
  { value: "", label: "No preference", hint: "Let the usual rules decide" },
  { value: "clear", label: "Clear out", hint: "Keep the copies elsewhere and let this folder's go" }
];

/** "How to treat each folder" — a saved decision that re-picks every automatic keeper. */
export function PreferredFoldersModal({
  options,
  draft,
  busy,
  error,
  onChange,
  onSave,
  onClose
}: {
  options: FolderOption[];
  draft: PreferenceDraft;
  busy: boolean;
  error: string;
  onChange: (next: PreferenceDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const set = (key: string, mode: FolderPreferenceMode | "") => {
    const next = { ...draft };
    if (mode === "") delete next[key];
    else next[key] = mode;
    onChange(next);
  };
  const marked = Object.keys(draft).length;

  return (
    <Modal title="How to treat each folder" onClose={onClose}>
      <p className="datagrid-muted dup-picker-note">
        When the same photo sits in several places, this decides which copy survives — before any of the automatic
        reasoning. <strong>Keep here</strong> means copies in that folder win. <strong>Clear out</strong> is the
        opposite: the copies elsewhere are kept and this folder's go, which is how you retire a folder whose photos
        are already filed properly somewhere else.
      </p>
      <p className="datagrid-muted dup-picker-note">
        Clearing out can't empty a folder on its own — a photo with no copy anywhere else isn't a duplicate, so it is
        never touched, and a set with nothing but cleared-out copies still keeps one. A folder covers everything below
        it, and the most specific instruction wins, so you can keep a whole library and clear out one folder inside it.
      </p>
      <div className="dup-folder-picker">
        {options.map((option) => (
          <div className="dup-folder-choice dup-folder-modes" key={option.key}>
            <span className="dup-folder-choice-body">
              <strong>{option.folderPath || "Library root"}</strong>
              <span className="datagrid-muted">{option.libraryName}</span>
            </span>
            <span className="dup-mode-group" role="radiogroup" aria-label={`How to treat ${option.folderPath || "the library root"}`}>
              {MODES.map((mode) => (
                <label className={`dup-mode${(draft[option.key] ?? "") === mode.value ? " is-on" : ""}`} key={mode.label} title={mode.hint}>
                  <input
                    type="radio"
                    name={`pref-${option.key}`}
                    checked={(draft[option.key] ?? "") === mode.value}
                    disabled={busy}
                    onChange={() => set(option.key, mode.value)}
                  />
                  <span>{mode.label}</span>
                </label>
              ))}
            </span>
          </div>
        ))}
      </div>
      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="text" disabled={busy || marked === 0} onClick={() => onChange({})}>Clear all</Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={onSave}>{busy ? "Saving…" : "Save"}</Button>
      </div>
    </Modal>
  );
}

// ── One box for every way of narrowing the page ─────────────────────────────
//
// Library, tier, folders and the search term were four controls in three places, and
// nothing said how they combined. They are one dialog now, in the order you'd reason
// in — which library, which kind, which folders, then the free-text sieve — with a
// count on the button so the page says it is narrowed even when the box is shut.
//
// This matters beyond tidiness: the bulk delete acts on exactly what these leave on
// screen, so "what am I filtered to?" and "what will that button do?" have to be the
// same question with one visible answer.
export interface DuplicateFilterState {
  scopeId: string;
  search: string;
  folders: string[];
  tier: DuplicateTier;
}

export type DuplicateTier = "all" | "exact" | "near";

const TIER_CHOICES: { value: DuplicateTier; label: string; hint: string }[] = [
  { value: "all", label: "All duplicates", hint: "Identical files and near-identical alike" },
  { value: "exact", label: "Identical files only", hint: "Byte-for-byte matches — nothing to compare" },
  { value: "near", label: "Near-identical only", hint: "Same picture, different file — worth a look first" }
];

/** How many of the four are doing something, for the button's badge. */
export function activeFilterCount(state: DuplicateFilterState, withTier: boolean): number {
  return (state.scopeId ? 1 : 0)
    + (state.search.trim() ? 1 : 0)
    + (state.folders.length > 0 ? 1 : 0)
    + (withTier && state.tier !== "all" ? 1 : 0);
}

export function DuplicateFiltersModal({
  state,
  options,
  libraries,
  withTier,
  onChange,
  onClose
}: {
  state: DuplicateFilterState;
  options: FolderOption[];
  libraries: DuplicateLibraryOption[];
  /** The photo page has two tiers to choose between; the folders page has none. */
  withTier: boolean;
  onChange: (next: DuplicateFilterState) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<DuplicateFilterState>) => onChange({ ...state, ...patch });
  const active = activeFilterCount(state, withTier);

  return (
    <Modal title="Narrow what's shown" onClose={onClose}>
      <div className="dup-filter-form">
        <label className="dup-filter-field">
          <span className="dup-filter-label">Library</span>
          <select value={state.scopeId} onChange={(event) => set({ scopeId: event.target.value })}>
            <option value="">All libraries</option>
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>{library.name}</option>
            ))}
          </select>
          <span className="dup-filter-hint">
            Choosing one compares its photos with each other; copies in other libraries drop out.
          </span>
        </label>

        {withTier && (
          <div className="dup-filter-field">
            <span className="dup-filter-label">Which duplicates</span>
            <div className="dup-tier-choices" role="radiogroup" aria-label="Which duplicates to show">
              {TIER_CHOICES.map((choice) => (
                <label className={`dup-tier-choice${state.tier === choice.value ? " is-on" : ""}`} key={choice.value}>
                  <input
                    type="radio"
                    name="dup-tier"
                    checked={state.tier === choice.value}
                    onChange={() => set({ tier: choice.value })}
                  />
                  <span>
                    <strong>{choice.label}</strong>
                    <span className="datagrid-muted">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="dup-filter-field">
          <span className="dup-filter-label">Search</span>
          <input
            type="search"
            value={state.search}
            placeholder="Filename, folder or library"
            onChange={(event) => set({ search: event.target.value })}
          />
          <span className="dup-filter-hint">Keeps a whole set when any copy in it matches.</span>
        </label>

        <div className="dup-filter-field">
          <span className="dup-filter-label">
            Folders {state.folders.length > 0 ? `(${state.folders.length} chosen)` : ""}
          </span>
          <span className="dup-filter-hint">
            Only folders something duplicated was found in. A folder covers everything below it.
          </span>
          {options.length > 0 ? (
            <div className="dup-folder-picker">
              {options.map((option) => (
                <label className="dup-folder-choice" key={option.key}>
                  <input
                    type="checkbox"
                    checked={state.folders.includes(option.key)}
                    onChange={(event) => set({
                      folders: event.target.checked
                        ? [...state.folders, option.key]
                        : state.folders.filter((key) => key !== option.key)
                    })}
                  />
                  <span className="dup-folder-choice-body">
                    <strong>{option.folderPath || "Library root"}</strong>
                    <span className="datagrid-muted">
                      {option.libraryName} · {option.setCount} set{option.setCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="datagrid-muted dup-filter-hint">Nothing found yet, so there are no folders to choose.</p>
          )}
        </div>
      </div>

      <div className="modal-actions">
        <Button
          variant="text"
          disabled={active === 0}
          onClick={() => onChange({ scopeId: "", search: "", folders: [], tier: "all" })}
        >
          Clear all
        </Button>
        <Button variant="secondary" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}
