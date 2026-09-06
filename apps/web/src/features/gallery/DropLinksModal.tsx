// Drop links for one Photo Inbox — docs/photo-inbox-proposal.md, phase 3. Mint a
// link for someone without an account (label, expiry, a file and size cap,
// one-time or standing), see the ones already out with what each received, and
// take one back. The address is shown once: only its fingerprint is kept.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { ToggleSwitch } from "../../shared/ToggleSwitch";
import { formatBytes } from "../../shared/utils";

export interface DropLinkSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  maxFiles: number | null;
  maxBytes: number | null;
  oneTime: boolean;
  used: { files: number; bytes: number };
  status: "active" | "expired" | "closed" | "revoked";
}

const EXPIRY_CHOICES = [1, 7, 14, 30, 90];

export function DropLinksModal({
  inbox,
  onClose
}: {
  inbox: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [links, setLinks] = useState<DropLinkSummary[] | null>(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [maxFiles, setMaxFiles] = useState("200");
  const [maxMB, setMaxMB] = useState("2048");
  const [oneTime, setOneTime] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; label: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<DropLinkSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api<{ links: DropLinkSummary[] }>(`/api/library/gallery/inbox/${inbox.id}/drop-links`);
      setLinks(payload.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:inbox.dropLinks.loadFailed"));
      setLinks([]);
    }
  }, [inbox.id, t]);

  useEffect(() => { void load(); }, [load]);

  const numberOrNull = (raw: string): number | null => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const create = async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const payload = await api<{ url: string; link: DropLinkSummary }>(`/api/library/gallery/inbox/${inbox.id}/drop-links`, {
        method: "POST",
        body: JSON.stringify({
          label: label.trim() || undefined,
          expiresInDays,
          maxFiles: numberOrNull(maxFiles),
          maxMB: numberOrNull(maxMB),
          oneTime
        })
      });
      setCreated({ url: payload.url, label: payload.link.label });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:inbox.dropLinks.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/shares/${revoking.id}`, { method: "DELETE" });
      setRevoking(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:inbox.dropLinks.revokeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (link: DropLinkSummary): string => t(`gallery:inbox.dropLinks.status.${link.status}`);
  const quotaLine = (link: DropLinkSummary): string => {
    const files = link.maxFiles == null
      ? t("gallery:inbox.dropLinks.usedFiles", { count: link.used.files })
      : t("gallery:inbox.dropLinks.usedFilesOf", { used: link.used.files, max: link.maxFiles });
    const bytes = link.maxBytes == null
      ? formatBytes(link.used.bytes)
      : t("gallery:inbox.dropLinks.usedBytesOf", { used: formatBytes(link.used.bytes), max: formatBytes(link.maxBytes) });
    return `${files} · ${bytes}`;
  };

  return (
    <Modal
      variant="panel"
      title={t("gallery:inbox.dropLinks.title")}
      subtitle={t("gallery:inbox.dropLinks.subtitle", { name: inbox.name })}
      icon={<Link2 size={24} />}
      busy={busy}
      className="gallery-drop-links-modal"
      onClose={onClose}
    >
      <p className="muted">{t("gallery:inbox.dropLinks.intro")}</p>

      {error && <MessageBox tone="error" title={t("gallery:inbox.dropLinks.errorTitle")}>{error}</MessageBox>}

      {created && (
        <MessageBox
          tone="success"
          title={t("gallery:inbox.dropLinks.createdTitle")}
          action={
            <Button variant="secondary" compact onClick={() => void copy()}>
              <Copy size={14} aria-hidden="true" />
              {copied ? t("gallery:inbox.dropLinks.copied") : t("gallery:inbox.dropLinks.copy")}
            </Button>
          }
        >
          <code className="gallery-drop-link-url">{created.url}</code>
          <p className="muted">{t("gallery:inbox.dropLinks.createdBody")}</p>
        </MessageBox>
      )}

      <form
        className="gallery-drop-link-form"
        onSubmit={(event) => { event.preventDefault(); void create(); }}
      >
        <h3>{t("gallery:inbox.dropLinks.newHeading")}</h3>
        <label className="field">
          <span>{t("gallery:inbox.dropLinks.labelField")}</span>
          <input
            type="text"
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("gallery:inbox.dropLinks.labelPlaceholder")}
            disabled={busy}
          />
          <small className="muted">{t("gallery:inbox.dropLinks.labelHint")}</small>
        </label>
        <div className="gallery-drop-link-grid">
          <label className="field">
            <span>{t("gallery:inbox.dropLinks.expiresField")}</span>
            <select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} disabled={busy}>
              {EXPIRY_CHOICES.map((days) => (
                <option key={days} value={days}>{t("gallery:inbox.dropLinks.expiresIn", { count: days })}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("gallery:inbox.dropLinks.maxFilesField")}</span>
            <input type="number" min={1} max={10000} value={maxFiles} onChange={(event) => setMaxFiles(event.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span>{t("gallery:inbox.dropLinks.maxSizeField")}</span>
            <input type="number" min={1} max={102400} value={maxMB} onChange={(event) => setMaxMB(event.target.value)} disabled={busy} />
          </label>
        </div>
        <label className="gallery-drop-link-toggle">
          <ToggleSwitch checked={oneTime} onChange={setOneTime} disabled={busy} ariaLabel={t("gallery:inbox.dropLinks.oneTime")} />
          <span>
            <strong>{t("gallery:inbox.dropLinks.oneTime")}</strong>
            <small className="muted">{t("gallery:inbox.dropLinks.oneTimeHint")}</small>
          </span>
        </label>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.close")}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("gallery:inbox.dropLinks.creating") : t("gallery:inbox.dropLinks.create")}
          </Button>
        </div>
      </form>

      <section className="gallery-drop-link-list" aria-label={t("gallery:inbox.dropLinks.existingHeading")}>
        <h3>{t("gallery:inbox.dropLinks.existingHeading")}</h3>
        {links === null ? (
          <p className="muted">{t("gallery:common.loading")}</p>
        ) : links.length === 0 ? (
          <p className="muted">{t("gallery:inbox.dropLinks.none")}</p>
        ) : (
          <ul>
            {links.map((link) => (
              <li key={link.id} className={`gallery-drop-link-row is-${link.status}`}>
                <span className="gallery-drop-link-copy">
                  <strong>{link.label ?? t("gallery:inbox.dropLinks.unlabelled")}</strong>
                  <small className="muted">
                    {quotaLine(link)}
                    {link.oneTime ? ` · ${t("gallery:inbox.dropLinks.oneTimeShort")}` : ""}
                    {` · ${t("gallery:inbox.dropLinks.expiresOn", { date: new Date(link.expiresAt).toLocaleDateString() })}`}
                  </small>
                </span>
                <span className={`status-badge ${link.status}`}>{statusLabel(link)}</span>
                {link.status === "active" && (
                  <Button
                    variant="icon"
                    danger
                    disabled={busy}
                    title={t("gallery:inbox.dropLinks.revoke")}
                    aria-label={t("gallery:inbox.dropLinks.revokeAria", { label: link.label ?? t("gallery:inbox.dropLinks.unlabelled") })}
                    onClick={() => setRevoking(link)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoking && (
        <ConfirmDialog
          title={t("gallery:inbox.dropLinks.revokeConfirmTitle", { label: revoking.label ?? t("gallery:inbox.dropLinks.unlabelled") })}
          confirmLabel={t("gallery:inbox.dropLinks.revokeConfirmLabel")}
          busyLabel={t("gallery:inbox.dropLinks.revoking")}
          busy={busy}
          danger
          onConfirm={() => void revoke()}
          onCancel={() => { if (!busy) setRevoking(null); }}
        >
          {t("gallery:inbox.dropLinks.revokeConfirmBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
