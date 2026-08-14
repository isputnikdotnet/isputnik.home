import { useEffect, useState, type FormEvent } from "react";
import { Check, MonitorSmartphone, Pencil, Trash2, Tv } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { navigate } from "../../router";

// Everywhere this account is signed in. Linked displays first, because they are
// the reason the page exists — they were authorized from somewhere else, they
// last a year, and nobody but the owner can be expected to remember them.
// Ordinary browsers are in the same list rather than hidden: two lists of the
// same thing invites the question of which one is complete.

interface SessionRow {
  id: string;
  kind: "browser" | "device";
  name: string;
  label: string | null;
  deviceName: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeen: string;
  current: boolean;
}

function whenSeen(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 2) return "active now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export function LinkedDevicesSection() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");

  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [label, setLabel] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [renameError, setRenameError] = useState("");

  const [pendingRemove, setPendingRemove] = useState<SessionRow | null>(null);
  const [removing, setRemoving] = useState(false);

  // Browsers are collapsed by default. A household laptop that signs in twice a
  // week accumulates rows nobody needs to read, and they would otherwise bury the
  // one linked display this page is about.
  const [showOthers, setShowOthers] = useState(false);

  const refresh = async () => {
    try {
      const result = await api<{ sessions: SessionRow[] }>("/api/account/sessions");
      setSessions(result.sessions);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to load your devices");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openRename = (session: SessionRow) => {
    setRenaming(session);
    setLabel(session.label ?? "");
    setRenameError("");
  };

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    setSavingName(true);
    setRenameError("");
    try {
      await api(`/api/account/sessions/${renaming.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label: label.trim() || null })
      });
      setRenaming(null);
      await refresh();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Unable to save that name");
    } finally {
      setSavingName(false);
    }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    setError("");
    try {
      await api(`/api/account/sessions/${pendingRemove.id}`, { method: "DELETE" });
      setPendingRemove(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove that device");
    } finally {
      setRemoving(false);
    }
  };

  const devices = (sessions ?? []).filter((session) => session.kind === "device");
  const browsers = (sessions ?? []).filter((session) => session.kind === "browser");

  const row = (session: SessionRow) => (
    <div className="device-row" key={session.id}>
      <span className="device-row-icon" aria-hidden="true">
        {session.kind === "device" ? <Tv size={18} /> : <MonitorSmartphone size={18} />}
      </span>
      <div className="device-row-meta">
        <strong>
          {session.name}
          {session.current && <span className="device-row-tag">This device</span>}
        </strong>
        <span className="device-row-detail">
          {whenSeen(session.lastSeen)}
          {session.ipAddress ? ` · ${session.ipAddress}` : ""}
          {session.kind === "device" ? ` · linked ${new Date(session.createdAt).toLocaleDateString()}` : ""}
        </span>
      </div>
      <div className="device-row-actions">
        <Button
          variant="icon"
          title="Rename"
          aria-label={`Rename ${session.name}`}
          onClick={() => openRename(session)}
        >
          <Pencil size={16} />
        </Button>
        {/* Ending the session you are asking with is signing out, which has its own
            button and also clears the cookie — the server refuses it here. */}
        {!session.current && (
          <Button
            variant="icon"
            danger
            title={session.kind === "device" ? "Revoke device" : "Sign this out"}
            aria-label={`Revoke ${session.name}`}
            onClick={() => setPendingRemove(session)}
          >
            <Trash2 size={16} />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <section className="linked-devices-section" aria-labelledby="linked-devices-heading">
      <h2 id="linked-devices-heading">Linked devices</h2>
      <p className="section-description">
        Televisions, wall displays and other screens you've signed in by scanning a code. They stay signed in
        until you remove them, and they can't reach the control panel.
      </p>

      {loadError && <MessageBox tone="error" title="Unable to load">{loadError}</MessageBox>}
      {error && <MessageBox tone="error" title="Unable to remove">{error}</MessageBox>}

      {sessions && (
        <>
          <div className="device-list">
            {devices.length === 0 ? (
              <p className="section-description">
                No linked devices yet. On the TV or display, open iSputnik and choose
                <strong> Link a TV or display</strong> — then scan the code it shows with this phone.
              </p>
            ) : (
              devices.map(row)
            )}
          </div>

          <div className="device-actions">
            <Button variant="secondary" onClick={() => navigate("/link")}>Link a device from here</Button>
          </div>

          <div className="device-others">
            <Button variant="text" onClick={() => setShowOthers((open) => !open)}>
              {showOthers
                ? "Hide other sign-ins"
                : `Show ${browsers.length} other sign-in${browsers.length === 1 ? "" : "s"}`}
            </Button>
            {showOthers && (
              <div className="device-list">
                {browsers.map(row)}
              </div>
            )}
          </div>
        </>
      )}

      {renaming && (
        <Modal variant="card" title="Rename this device" busy={savingName} onClose={() => setRenaming(null)} onSubmit={saveName}>
          <Field
            label="Name"
            value={label}
            onChange={setLabel}
            placeholder={renaming.name}
            required={false}
          />
          <p className="section-description">
            Leave it empty to go back to what the browser reports.
          </p>
          {renameError && <MessageBox tone="error" title="Unable to save">{renameError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRenaming(null)} disabled={savingName}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={savingName}>
              {savingName ? "Saving…" : <><Check size={16} /> Save name</>}
            </Button>
          </div>
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={`Revoke access for "${pendingRemove.name}"?`}
          confirmLabel={pendingRemove.kind === "device" ? "Revoke device" : "Sign out"}
          busyLabel="Revoking…"
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          That device is signed out immediately and will need authorizing again to come back. Nothing else about
          your account changes, and nothing is deleted.
        </ConfirmDialog>
      )}
    </section>
  );
}
