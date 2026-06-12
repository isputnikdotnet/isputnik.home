import { useState, useEffect, useCallback, useMemo } from "react";
import { LogOut, Monitor, Search } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Button } from "../../../shared/Button";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedSession } from "../types";

function sessionDeviceLabel(session: ManagedSession) {
  const device = session.deviceName?.trim() || "Unknown device";
  return session.ipAddress ? `${device} - ${session.ipAddress}` : device;
}

export function SessionsSection() {
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingRevoke, setPendingRevoke] = useState<ManagedSession | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadSessions = useCallback(async () => {
    const payload = await api<{ sessions: ManagedSession[] }>("/api/sessions");
    setSessions(payload.sessions);
  }, []);

  useEffect(() => {
    loadSessions().catch((err) => setError(err instanceof Error ? err.message : "Unable to load sessions"));
  }, [loadSessions]);

  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => [
      session.displayName,
      session.email,
      session.deviceName ?? "",
      session.ipAddress ?? "",
      session.current ? "current" : ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [searchQuery, sessions]);

  const revokeSession = async () => {
    if (!pendingRevoke) return;

    setRevoking(true);
    setModalError("");
    try {
      await api(`/api/sessions/${pendingRevoke.id}`, { method: "DELETE" });
      setPendingRevoke(null);
      await loadSessions();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Unable to revoke session");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon sessions" aria-hidden="true">
            <Monitor size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">User administration</p>
            <h1>Active sessions</h1>
            <p className="section-description">Review signed-in devices and revoke access.</p>
          </div>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Session management error">{error}</MessageBox>}

      <div className="admin-controls-bar">
        <label className="search-field admin-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search sessions</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search sessions..."
          />
        </label>
      </div>

      {visibleSessions.length === 0 ? (
        <p className="management-empty">
          {sessions.length === 0 ? "No active sessions found." : "No sessions match this search."}
        </p>
      ) : (
        <div className="datagrid-wrap admin-table-wrap">
          <table className="datagrid admin-table session-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Device</th>
                <th>Last seen</th>
                <th>Expires</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleSessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <div className="datagrid-primary">
                      <span className="admin-name-line">
                        <strong>{session.displayName}</strong>
                        {session.current && <span className="status-badge current">Current</span>}
                      </span>
                      <small>{session.email}</small>
                    </div>
                  </td>
                  <td>
                    <span className="datagrid-muted session-device-cell">{sessionDeviceLabel(session)}</span>
                  </td>
                  <td className="datagrid-muted">{formatManagedDate(session.lastSeen)}</td>
                  <td className="datagrid-muted">{formatManagedDate(session.expiresAt)}</td>
                  <td className="col-actions">
                    {session.current ? (
                      <span className="status-badge current">Current</span>
                    ) : (
                      <Button
                        variant="icon"
                        danger
                        title="Revoke session"
                        aria-label={`Revoke session for ${session.displayName}`}
                        onClick={() => {
                          setModalError("");
                          setPendingRevoke(session);
                        }}
                      >
                        <LogOut size={15} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title={`Revoke session for "${pendingRevoke.displayName}"?`}
          confirmLabel="Revoke session"
          busyLabel="Revoking..."
          confirmIcon={<LogOut size={15} />}
          danger
          rich
          busy={revoking}
          error={modalError}
          onConfirm={revokeSession}
          onCancel={() => setPendingRevoke(null)}
        >
          <p>This will sign the user out on that device.</p>
          <p><strong>The user account, password, and other active sessions are not changed.</strong></p>
        </ConfirmDialog>
      )}
    </>
  );
}
