import { useEffect, useRef, useState } from "react";
import { Copy, ImageOff, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";

interface DuplicateMember {
  itemId: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  takenAt: string | null;
  camera: string | null;
  linkCount: number;
  isKeeper: boolean;
}

interface DuplicateGroup {
  id: string;
  kind: "exact" | "near";
  keeperItemId: string | null;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  reclaimableBytes: number;
  members: DuplicateMember[];
}

interface DuplicateLibraryOption {
  id: string;
  name: string;
  candidateCount: number;
  pendingCount: number;
}

interface DuplicatePayload {
  groups: DuplicateGroup[];
  lastScanAt: string | null;
  candidateCount: number;
  scanning: boolean;
  reclaimableBytes: number;
  pendingCount: number;
  staleCount: number;
  libraries: DuplicateLibraryOption[];
}

const EMPTY: DuplicatePayload = {
  groups: [], lastScanAt: null, candidateCount: 0, pendingCount: 0, staleCount: 0,
  scanning: false, reclaimableBytes: 0, libraries: []
};

// What choosing this scope would cost: files a scan has to open and read. Everything
// already hashed by an earlier run is reused, so a re-scan of settled photos reads
// nothing — say "up to date" rather than showing a stale-looking 0.
function scopeCost(pending: number): string {
  return pending === 0 ? "up to date" : `${pending} to check`;
}

function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function copies(n: number): string {
  return `${n} cop${n === 1 ? "y" : "ies"}`;
}

function dimensions(member: DuplicateMember): string {
  return member.width && member.height ? `${member.width} × ${member.height}` : "Unknown size";
}

export function DuplicatePhotosSection() {
  const [payload, setPayload] = useState<DuplicatePayload>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [starting, setStarting] = useState(false);
  const [busyGroupId, setBusyGroupId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DuplicateGroup | null>(null);
  const [ignoreTarget, setIgnoreTarget] = useState<DuplicateGroup | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  // "" = every gallery library.
  const [scopeId, setScopeId] = useState("");
  const pollRef = useRef<number | null>(null);

  // Normalise before storing. The render walks payload.groups directly, so a response
  // missing a field would throw during render and blank the entire app rather than just
  // this panel — degrade to an empty list instead of taking everything down.
  const applyPayload = (next: Partial<DuplicatePayload>) => {
    setPayload({
      groups: next.groups ?? [],
      lastScanAt: next.lastScanAt ?? null,
      candidateCount: next.candidateCount ?? 0,
      scanning: next.scanning ?? false,
      reclaimableBytes: next.reclaimableBytes ?? 0,
      pendingCount: next.pendingCount ?? 0,
      staleCount: next.staleCount ?? 0,
      libraries: next.libraries ?? []
    });
  };

  const load = async () => {
    applyPayload(await api<DuplicatePayload>("/api/library/gallery/duplicates"));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load duplicate photos"))
      .finally(() => setLoaded(true));
  }, []);

  // A scan runs in the background, so poll while one is in flight and stop as soon as
  // it finishes (the results arrive with the same payload).
  useEffect(() => {
    if (!payload.scanning) {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => { void load().catch(() => { /* keep polling */ }); }, 3000);
    return () => {
      if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [payload.scanning]);

  const exact = payload.groups.filter((group) => group.kind === "exact");
  const near = payload.groups.filter((group) => group.kind === "near");
  const extraCopies = payload.groups.reduce((sum, group) => sum + group.members.length - 1, 0);
  const busy = starting || deletingAll || busyGroupId !== "";

  const startScan = async () => {
    setStarting(true);
    setActionError("");
    try {
      applyPayload(await api<DuplicatePayload>("/api/library/gallery/duplicates/scan", {
        method: "POST",
        body: JSON.stringify({ libraryId: scopeId || null })
      }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to start the scan");
    } finally {
      setStarting(false);
    }
  };

  const chooseKeeper = async (group: DuplicateGroup, member: DuplicateMember) => {
    if (member.isKeeper) return;
    setBusyGroupId(group.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${group.id}/keeper`, {
        method: "POST",
        body: JSON.stringify({ itemId: member.itemId })
      });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to change which copy is kept");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyGroupId(deleteTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${deleteTarget.id}/resolve`, { method: "POST", body: "{}" });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the extra copies");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmIgnore = async () => {
    if (!ignoreTarget) return;
    setBusyGroupId(ignoreTarget.id);
    setActionError("");
    try {
      await api(`/api/library/gallery/duplicates/${ignoreTarget.id}/ignore`, { method: "POST", body: "{}" });
      setIgnoreTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to dismiss the set");
    } finally {
      setBusyGroupId("");
    }
  };

  const confirmDeleteAll = async () => {
    setDeletingAll(true);
    setActionError("");
    try {
      await api("/api/library/gallery/duplicates/resolve-all", { method: "POST", body: "{}" });
      setDeleteAllOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the extra copies");
    } finally {
      setDeletingAll(false);
    }
  };

  const renderGroup = (group: DuplicateGroup) => {
    const keeper = group.members.find((member) => member.isKeeper);
    const extras = group.members.length - 1;
    return (
      <div className="dup-group" key={group.id}>
        <div className="dup-group-head">
          <div className="dup-group-summary">
            <strong>{group.members.length} copies of the same photo</strong>
            <span className="datagrid-muted">
              {" · "}{formatBytes(group.reclaimableBytes)} to reclaim
              {group.keeperSource === "manual"
                ? " · you chose which copy to keep"
                : group.keeperReason ? ` · keeping the one that is ${group.keeperReason}` : ""}
            </span>
          </div>
          <div className="dup-group-actions">
            <Button
              variant="secondary"
              compact
              disabled={busy}
              onClick={() => { setActionError(""); setIgnoreTarget(group); }}
            >
              Not duplicates
            </Button>
            <Button
              variant="danger"
              compact
              disabled={busy || !keeper}
              onClick={() => { setActionError(""); setDeleteTarget(group); }}
            >
              <Trash2 size={14} />
              <span>Delete {copies(extras)}</span>
            </Button>
          </div>
        </div>

        <div className="dup-copies">
          {group.members.map((member) => (
            <Button
              key={member.itemId}
              variant="text"
              className={`dup-copy${member.isKeeper ? " is-keeper" : ""}`}
              aria-pressed={member.isKeeper}
              disabled={busy}
              title={`${member.libraryName} · ${member.path}\n${member.isKeeper ? "This copy is being kept" : "Keep this copy instead"}`}
              onClick={() => void chooseKeeper(group, member)}
            >
              <span className="dup-copy-thumb" aria-hidden="true">
                {member.coverUrl ? <img src={member.coverUrl} alt="" loading="lazy" /> : <ImageOff size={16} />}
              </span>
              <span className="dup-copy-badge">{member.isKeeper ? "Keeping" : "Keep this one"}</span>
              <span className="dup-copy-meta">
                {dimensions(member)}
                {member.size != null ? ` · ${formatBytes(member.size)}` : ""}
                {member.linkCount > 0 ? ` · ${member.linkCount} tag${member.linkCount === 1 ? "" : "s"}/links` : ""}
              </span>
              <span className="dup-copy-path">{member.libraryName} · {member.path}</span>
            </Button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <Copy size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">Digital Library</p>
            <h1>Duplicate photos</h1>
          </div>
        </div>
        <div className="dup-head-actions">
          {exact.length > 0 && (
            <Button variant="danger" compact disabled={busy} onClick={() => { setActionError(""); setDeleteAllOpen(true); }}>
              <Trash2 size={14} />
              <span>Delete all extras</span>
            </Button>
          )}
          <select
            className="dup-scope"
            value={scopeId}
            disabled={busy || payload.scanning}
            aria-label="Which photo library to scan"
            title="How many photos a scan of this library would need to read from disk"
            onChange={(event) => setScopeId(event.target.value)}
          >
            <option value="">All photo libraries — {scopeCost(payload.pendingCount)}</option>
            {payload.libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name} — {scopeCost(library.pendingCount)}
              </option>
            ))}
          </select>
          <Button variant="secondary" compact disabled={busy || payload.scanning} onClick={startScan}>
            <RefreshCw size={14} />
            <span>{payload.scanning ? "Scanning…" : starting ? "Starting…" : "Scan now"}</span>
          </Button>
        </div>
      </div>

      {/* The counts beside each library in the picker are how many files a scan of it
          would have to read, so they aren't repeated here. */}
      <p className="dup-status datagrid-muted">
        Last scan: {formatWhen(payload.lastScanAt)}
        {payload.groups.length > 0
          ? ` · ${payload.groups.length} duplicate set${payload.groups.length === 1 ? "" : "s"}, ${copies(extraCopies)} using ${formatBytes(payload.reclaimableBytes)}`
          : ""}
      </p>

      {payload.scanning && (
        <MessageBox tone="info" title="Scan running">
          Reading the photos that share a file size with another photo. Results appear here as soon as it finishes — you
          can leave this page. Progress is on the Tasks tab.
        </MessageBox>
      )}
      {payload.staleCount > 0 && !payload.scanning && (
        <MessageBox tone="warning" title="Some photos have changed on disk">
          {payload.staleCount} photo{payload.staleCount === 1 ? "" : "s"} no longer match{payload.staleCount === 1 ? "es" : ""} what
          the catalogue records, so {payload.staleCount === 1 ? "it was" : "they were"} left out of this comparison.
          Rescan the library from the Libraries tab, then scan for duplicates again.
        </MessageBox>
      )}
      {error && <MessageBox tone="error" title="Unable to load duplicate photos">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

      {loaded && payload.groups.length === 0 && !error ? (
        <p className="management-empty">
          {payload.lastScanAt
            ? "No duplicate photos found — every catalogued photo is unique."
            : "No scan has run yet. Choose “Scan now” to look for duplicate photos."}
        </p>
      ) : null}

      {exact.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Identical files</h2>
          <div className="dup-groups">{exact.map(renderGroup)}</div>
        </>
      )}

      {near.length > 0 && (
        <>
          <h2 className="dup-tier-heading">Near-identical</h2>
          <p className="datagrid-muted dup-tier-note">
            Same picture, different file — a resized or re-compressed copy. Check these before removing anything.
          </p>
          <div className="dup-groups">{near.map(renderGroup)}</div>
        </>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${copies(deleteTarget.members.length - 1)} of this photo?`}
          confirmLabel="Delete copies"
          busyLabel="Deleting…"
          danger
          busy={busyGroupId === deleteTarget.id}
          error={actionError}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
          rich
        >
          <p>
            The copy at <strong>{deleteTarget.members.find((m) => m.isKeeper)?.path}</strong> is kept. Any tags, albums,
            collections and tagged people on the other copies move onto it first, so nothing you filed by hand is lost.
          </p>
          <p>
            The extra copies go to the Recycle Bin, where they can be restored until it's emptied. The kept photo is not
            affected.
          </p>
        </ConfirmDialog>
      )}

      {ignoreTarget && (
        <ConfirmDialog
          title="Mark these as different photos?"
          confirmLabel="Not duplicates"
          busyLabel="Saving…"
          busy={busyGroupId === ignoreTarget.id}
          error={actionError}
          onConfirm={confirmIgnore}
          onCancel={() => setIgnoreTarget(null)}
        >
          This set disappears from the list and future scans won't group these photos together again. Nothing is deleted
          and no photo is changed.
        </ConfirmDialog>
      )}

      {deleteAllOpen && (
        <ConfirmDialog
          title={`Delete the extra copies in ${exact.length} set${exact.length === 1 ? "" : "s"}?`}
          confirmLabel={`Delete ${copies(exact.reduce((sum, group) => sum + group.members.length - 1, 0))}`}
          busyLabel="Deleting…"
          danger
          busy={deletingAll}
          error={actionError}
          onConfirm={confirmDeleteAll}
          onCancel={() => setDeleteAllOpen(false)}
          rich
        >
          <p>
            One copy is kept from every set of identical files — the one marked “Keeping”, including any you chose
            yourself. Their tags, albums and tagged people are merged onto it first.
          </p>
          <p>
            This frees about {formatBytes(exact.reduce((sum, group) => sum + group.reclaimableBytes, 0))}. Everything
            removed goes to the Recycle Bin and can be restored until it's emptied. Near-identical sets are never
            touched by this button.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
