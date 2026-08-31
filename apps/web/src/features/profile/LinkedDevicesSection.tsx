import { useEffect, useState, type FormEvent } from "react";
import { Check, MonitorSmartphone, Pencil, Trash2, Tv } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { navigate } from "../../router";
import i18n from "../../i18n";

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
  if (minutes < 2) return i18n.t("misc:devices.activeNow");
  if (minutes < 60) return i18n.t("misc:devices.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return i18n.t("misc:devices.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return i18n.t("misc:devices.daysAgo", { count: days });
  return new Date(iso).toLocaleDateString();
}

export function LinkedDevicesSection() {
  const { t } = useTranslation(["common", "misc"]);
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
      setLoadError(err instanceof Error ? err.message : t("misc:devices.unableToLoadFallback"));
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
      setRenameError(err instanceof Error ? err.message : t("misc:devices.unableToRenameFallback"));
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
      setError(err instanceof Error ? err.message : t("misc:devices.unableToRemoveFallback"));
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
          {session.current && <span className="device-row-tag">{t("misc:devices.currentDeviceTag")}</span>}
        </strong>
        <span className="device-row-detail">
          {whenSeen(session.lastSeen)}
          {session.ipAddress ? ` · ${session.ipAddress}` : ""}
          {session.kind === "device" ? ` · ${t("misc:devices.linkedOn", { date: new Date(session.createdAt).toLocaleDateString() })}` : ""}
        </span>
      </div>
      <div className="device-row-actions">
        <Button
          variant="icon"
          title={t("misc:devices.rename")}
          aria-label={t("misc:devices.renameAria", { name: session.name })}
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
            title={session.kind === "device" ? t("misc:devices.revokeDevice") : t("misc:devices.signThisOut")}
            aria-label={t("misc:devices.revokeAria", { name: session.name })}
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
      <h2 id="linked-devices-heading">{t("misc:devices.heading")}</h2>
      <p className="section-description">
        {t("misc:devices.description")}
      </p>

      {loadError && <MessageBox tone="error" title={t("misc:common.unableToLoad")}>{loadError}</MessageBox>}
      {error && <MessageBox tone="error" title={t("misc:devices.removeErrorTitle")}>{error}</MessageBox>}

      {sessions && (
        <>
          <div className="device-list">
            {devices.length === 0 ? (
              <p className="section-description">
                <Trans i18nKey="devices.emptyBody" ns="misc" components={{ bold: <strong /> }} />
              </p>
            ) : (
              devices.map(row)
            )}
          </div>

          <div className="device-actions">
            <Button variant="secondary" onClick={() => navigate("/link")}>{t("misc:devices.linkFromHere")}</Button>
          </div>

          <div className="device-others">
            <Button variant="text" onClick={() => setShowOthers((open) => !open)}>
              {showOthers
                ? t("misc:devices.hideOthers")
                : t("misc:devices.showOthers", { count: browsers.length })}
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
        <Modal variant="card" title={t("misc:devices.renameModalTitle")} busy={savingName} onClose={() => setRenaming(null)} onSubmit={saveName}>
          <Field
            label={t("misc:devices.nameLabel")}
            value={label}
            onChange={setLabel}
            placeholder={renaming.name}
            required={false}
          />
          <p className="section-description">
            {t("misc:devices.nameHint")}
          </p>
          {renameError && <MessageBox tone="error" title={t("misc:devices.renameErrorTitle")}>{renameError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setRenaming(null)} disabled={savingName}>{t("common:common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={savingName}>
              {savingName ? t("misc:common.saving") : <><Check size={16} /> {t("misc:devices.saveName")}</>}
            </Button>
          </div>
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t("misc:devices.confirmRevokeTitle", { name: pendingRemove.name })}
          confirmLabel={pendingRemove.kind === "device" ? t("misc:devices.confirmRevokeDevice") : t("misc:devices.confirmSignOut")}
          busyLabel={t("misc:devices.confirmRevokeBusy")}
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          {t("misc:devices.confirmRevokeBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
