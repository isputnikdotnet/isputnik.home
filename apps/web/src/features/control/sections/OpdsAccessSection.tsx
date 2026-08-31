import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../i18n";
import { QRCodeSVG } from "qrcode.react";
import { BookOpen, Check, Copy, Plus, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { ControlSectionHead } from "../ControlSectionHead";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { Modal } from "../../../shared/Modal";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";

interface OpdsToken {
  id: string;
  label: string | null;
  scope: string;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  expiresAt: string | null;
}

// The one-time secret payload returned when a token is minted.
interface CreatedToken {
  id: string;
  token: string;
  catalogUrl: string;
  basicUrl: string;
  username: string;
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  return (
    <div className="opds-copy-row">
      <span className="opds-copy-label">{label}</span>
      <code className="opds-copy-value">{value}</code>
      <Button variant="icon" title={t("controlAdmin:opds.copyLabel", { label })} aria-label={t("controlAdmin:opds.copyLabel", { label })} onClick={onCopy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
}

export function OpdsAccessSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [tokens, setTokens] = useState<OpdsToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const [pendingRemove, setPendingRemove] = useState<OpdsToken | null>(null);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    try {
      const payload = await api<{ tokens: OpdsToken[] }>("/api/account/tokens");
      setTokens(payload.tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:opds.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      /* clipboard unavailable — the value is still visible to copy by hand */
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
    setLabel("");
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const payload = await api<CreatedToken>("/api/account/tokens", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || undefined })
      });
      setCreated(payload);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("controlAdmin:opds.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    setError("");
    try {
      await api(`/api/account/tokens/${pendingRemove.id}`, { method: "DELETE" });
      setPendingRemove(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:opds.removeFailed"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="opds-access">
      <ControlSectionHead
        section="readerAccess"
        icon={<BookOpen size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:opds.headDescription")}
      />

      <p className="opds-intro">
        {t("controlAdmin:opds.intro")}
      </p>

      {error && <MessageBox tone="error" title={t("controlAdmin:opds.errorTitle")}>{error}</MessageBox>}

      <div className="opds-actions">
        <Button variant="primary" onClick={openCreate}>
          <Plus size={16} /> {t("controlAdmin:opds.createToken")}
        </Button>
      </div>

      <div className="opds-token-list">
        {loading ? (
          <p className="opds-intro">{t("controlAdmin:ui.loading")}</p>
        ) : tokens.length === 0 ? (
          <p className="opds-intro">{t("controlAdmin:opds.noTokens")}</p>
        ) : (
          tokens.map((token) => (
            <div className="opds-token-row" key={token.id}>
              <div className="opds-token-meta">
                <strong>{token.label || t("controlAdmin:opds.defaultLabel")}</strong>
                <span className="opds-intro">
                  {t("controlAdmin:opds.added", { date: new Date(token.createdAt).toLocaleDateString(i18n.language) })}
                  {token.lastSeen
                    ? t("controlAdmin:opds.lastUsed", { date: new Date(token.lastSeen).toLocaleDateString(i18n.language) })
                    : t("controlAdmin:opds.neverUsed")}
                </span>
              </div>
              <Button
                variant="icon"
                danger
                title={t("controlAdmin:opds.removeToken")}
                aria-label={t("controlAdmin:opds.removeAria", { label: token.label || t("controlAdmin:opds.defaultLabel") })}
                onClick={() => setPendingRemove(token)}
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
          title={created ? t("controlAdmin:opds.modalTitleCreated") : t("controlAdmin:opds.modalTitleCreate")}
          busy={creating}
          onClose={closeCreate}
          onSubmit={created ? undefined : create}
        >
          {created ? (
            <div className="opds-created">
              <MessageBox tone="success" title={t("controlAdmin:opds.copyNowTitle")}>
                {t("controlAdmin:opds.copyNowBody")}
              </MessageBox>

              <CopyRow label={t("controlAdmin:opds.catalogLink")} value={created.catalogUrl} copied={copied === "catalog"} onCopy={() => copy("catalog", created.catalogUrl)} />

              <div className="opds-qr">
                <QRCodeSVG value={created.catalogUrl} size={140} bgColor="#ffffff" fgColor="#031116" />
                <span className="opds-intro">{t("controlAdmin:opds.qrHint")}</span>
              </div>

              <details className="opds-basic">
                <summary>{t("controlAdmin:opds.basicSummary")}</summary>
                <CopyRow label={t("controlAdmin:opds.serverUrl")} value={created.basicUrl} copied={copied === "basicurl"} onCopy={() => copy("basicurl", created.basicUrl)} />
                <CopyRow label={t("controlAdmin:ui.username")} value={created.username} copied={copied === "user"} onCopy={() => copy("user", created.username)} />
                <CopyRow label={t("controlAdmin:opds.passwordToken")} value={created.token} copied={copied === "pwd"} onCopy={() => copy("pwd", created.token)} />
              </details>

              <div className="modal-actions">
                <Button variant="primary" onClick={closeCreate}>{t("common.done")}</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="opds-intro">{t("controlAdmin:opds.deviceNameIntro")}</p>
              <Field label={t("controlAdmin:opds.deviceName")} value={label} onChange={setLabel} placeholder={t("controlAdmin:opds.deviceNamePlaceholder")} required={false} />
              {createError && <MessageBox tone="error" title={t("controlAdmin:opds.createFailed")}>{createError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeCreate} disabled={creating}>{t("common.cancel")}</Button>
                <Button variant="primary" type="submit" disabled={creating}>
                  {creating ? t("controlAdmin:opds.creating") : t("controlAdmin:opds.createToken")}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title={t("controlAdmin:opds.confirmRemoveTitle", { label: pendingRemove.label || t("controlAdmin:opds.defaultLabel") })}
          confirmLabel={t("controlAdmin:opds.removeToken")}
          busyLabel={t("controlAdmin:opds.removing")}
          danger
          busy={removing}
          onConfirm={remove}
          onCancel={() => setPendingRemove(null)}
        >
          {t("controlAdmin:opds.confirmRemoveBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
