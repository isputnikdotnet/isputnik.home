import { useState, useEffect } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedSession } from "../types";

export function SessionsSection() {
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [error, setError] = useState("");
  const [pendingRevoke, setPendingRevoke] = useState<ManagedSession | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadSessions = async () => {
    const payload = await api<{ sessions: ManagedSession[] }>("/api/sessions");
    setSessions(payload.sessions);
  };

  useEffect(() => {
    loadSessions().catch((err) => setError(err instanceof Error ? err.message : "Unable to load sessions"));
  }, []);

  useEffect(() => {
    if (!pendingRevoke) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !revoking) {
        setPendingRevoke(null);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [pendingRevoke, revoking]);

  const revokeSession = async () => {
    if (!pendingRevoke) {
      return;
    }

    setRevoking(true);
    setError("");
    try {
      await api(`/api/sessions/${pendingRevoke.id}`, { method: "DELETE" });
      setPendingRevoke(null);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke session");
      setPendingRevoke(null);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Management</p>
          <h1>Active sessions</h1>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Session management error">{error}</MessageBox>}

      <div className="session-list">
        {sessions.map((session) => (
          <article className="session-row" key={session.id}>
            <div className="session-owner">
              <strong>{session.displayName}</strong>
              <span>{session.email}</span>
            </div>
            <div className="session-meta">
              <span>Last seen {formatManagedDate(session.lastSeen)}</span>
              <span>Expires {formatManagedDate(session.expiresAt)}</span>
              <span>{session.deviceName ?? "Unknown device"}{session.ipAddress ? ` - ${session.ipAddress}` : ""}</span>
            </div>
            {session.current ? (
              <span className="current-badge">Current</span>
            ) : (
              <button className="text-button" onClick={() => setPendingRevoke(session)}>
                Revoke
              </button>
            )}
          </article>
        ))}
        {sessions.length === 0 && <p className="management-empty">No active sessions found.</p>}
      </div>

      {pendingRevoke && (
        <ConfirmDialog
          title="Revoke session?"
          confirmLabel="Revoke session"
          busyLabel="Revoking..."
          danger
          busy={revoking}
          onConfirm={revokeSession}
          onCancel={() => setPendingRevoke(null)}
        >
          {pendingRevoke.displayName} will need to sign in again on this device.
        </ConfirmDialog>
      )}
    </>
  );
}
