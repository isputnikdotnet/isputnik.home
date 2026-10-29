import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { api } from "../../api";
import { PROFILE_ANCHORS } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatDate } from "../../shared/dates";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

interface StremioLink {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
}

/** The one-time answer when a link is made: the token is inside both addresses. */
interface CreatedLink {
  id: string;
  manifestUrl: string;
  installUrl: string;
}

// Profile › Security › Stremio: a personal add-on link per device into the video
// libraries this person may see (docs/stremio-plan.md). Shown only where Video is
// set up and the person may use it — or while they still hold a link to revoke.
export function StremioSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [links, setLinks] = useState<StremioLink[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);

  const [pendingRevoke, setPendingRevoke] = useState<StremioLink | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api<{ enabled: boolean; links: StremioLink[] }>("/api/account/stremio");
      setEnabled(payload.enabled);
      setLinks(payload.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:stremio.loadFailed"));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (link: StremioLink) => link.label || t("controlAdmin:stremio.defaultLabel");

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the address is still on screen to copy by hand */
    }
  };

  const openCreate = () => {
    setLabel("");
    setCreateError("");
    setCreated(null);
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreated(null);
    setCreateError("");
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      setCreated(await api<CreatedLink>("/api/account/stremio", { method: "POST", body: JSON.stringify({ label: label.trim() || undefined }) }));
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("controlAdmin:stremio.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    setRevoking(true);
    setError("");
    try {
      await api(`/api/account/stremio/${pendingRevoke.id}`, { method: "DELETE" });
      setPendingRevoke(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:stremio.revokeFailed"));
    } finally {
      setRevoking(false);
    }
  };

  if (!loaded || (!enabled && links.length === 0 && !error)) return null;

  return (
    <section className="opds-access" id={PROFILE_ANCHORS.stremio.id} aria-labelledby="stremio-heading">
      <h2 id="stremio-heading">{t("controlAdmin:stremio.title")}</h2>
      <p className="opds-intro">{t("controlAdmin:stremio.intro")}</p>
      <p className="opds-intro">{t("controlAdmin:stremio.homeOnly")}</p>

      {error && <MessageBox tone="error" title={t("controlAdmin:stremio.loadFailed")}>{error}</MessageBox>}

      {enabled && (
        <div className="opds-actions">
          <Button variant="primary" onClick={openCreate}>
            <Plus size={16} /> {t("controlAdmin:stremio.createLink")}
          </Button>
        </div>
      )}

      <div className="opds-token-list">
        {links.length === 0 ? (
          <p className="opds-intro">{t("controlAdmin:stremio.noLinks")}</p>
        ) : (
          links.map((link) => (
            <div className="opds-token-row" key={link.id}>
              <div className="opds-token-meta">
                <strong>{nameOf(link)}</strong>
                <span className="opds-intro">
                  {t("controlAdmin:stremio.added", { date: formatDate(link.createdAt) })}
                  {link.lastSeen ? t("controlAdmin:stremio.lastUsed", { date: formatDate(link.lastSeen) }) : t("controlAdmin:stremio.neverUsed")}
                </span>
              </div>
              <Button
                variant="icon"
                danger
                title={t("controlAdmin:stremio.revoke")}
                aria-label={t("controlAdmin:stremio.revokeAria", { label: nameOf(link) })}
                onClick={() => setPendingRevoke(link)}
              >
                <Trash2 size={18} />
              </Button>
            </div>
          ))
        )}
      </div>

      {createOpen && (
        <Modal
          variant="card"
          className="opds-token-modal"
          title={created ? t("controlAdmin:stremio.modalTitleCreated") : t("controlAdmin:stremio.modalTitleCreate")}
          busy={creating}
          onClose={closeCreate}
          onSubmit={created ? undefined : create}
        >
          {created ? (
            <div className="opds-created">
              <MessageBox tone="success" title={t("controlAdmin:stremio.copyNowTitle")}>
                {t("controlAdmin:stremio.copyNowBody")}
              </MessageBox>
              <div className="opds-actions">
                {/* stremio:// hands the link to the app's own install dialog. */}
                <Button variant="primary" onClick={() => { window.location.href = created.installUrl; }}>
                  <ExternalLink size={16} /> {t("controlAdmin:stremio.install")}
                </Button>
              </div>
              <div className="opds-copy-row">
                <span className="opds-copy-label">{t("controlAdmin:stremio.manifestLink")}</span>
                <code className="opds-copy-value">{created.manifestUrl}</code>
                <Button
                  variant="icon"
                  title={t("controlAdmin:stremio.copyLabel", { label: t("controlAdmin:stremio.manifestLink") })}
                  aria-label={t("controlAdmin:stremio.copyLabel", { label: t("controlAdmin:stremio.manifestLink") })}
                  onClick={() => copy(created.manifestUrl)}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </Button>
              </div>
              <div className="opds-qr">
                <QRCodeSVG value={created.manifestUrl} size={140} bgColor="#ffffff" fgColor="#031116" />
                <span className="opds-intro">{t("controlAdmin:stremio.qrHint")}</span>
              </div>
              <p className="opds-intro">{t("controlAdmin:stremio.installHint")}</p>
              <div className="modal-actions">
                <Button variant="primary" onClick={closeCreate}>{t("common.done")}</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="opds-intro">{t("controlAdmin:stremio.deviceIntro")}</p>
              <Field label={t("controlAdmin:stremio.deviceName")} value={label} onChange={setLabel} placeholder={t("controlAdmin:stremio.deviceNamePlaceholder")} required={false} />
              {createError && <MessageBox tone="error" title={t("controlAdmin:stremio.createFailed")}>{createError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeCreate} disabled={creating}>{t("common.cancel")}</Button>
                <Button variant="primary" type="submit" disabled={creating}>
                  {creating ? t("controlAdmin:stremio.creating") : t("controlAdmin:stremio.createLink")}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title={t("controlAdmin:stremio.confirmRevokeTitle", { label: nameOf(pendingRevoke) })}
          confirmLabel={t("controlAdmin:stremio.revoke")}
          busyLabel={t("controlAdmin:stremio.revoking")}
          danger
          busy={revoking}
          onConfirm={revoke}
          onCancel={() => setPendingRevoke(null)}
        >
          {t("controlAdmin:stremio.confirmRevokeBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
