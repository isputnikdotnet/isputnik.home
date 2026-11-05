import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Plus, Smartphone, Trash2 } from "lucide-react";
import { api } from "../../api";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatDate } from "../../shared/dates";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

interface Phone {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
}

interface PhonesView {
  unavailable: "off" | "no_library" | null;
  maxPhones: number;
  phones: Phone[];
}

interface SetupDetails {
  /** The admin's "Address phones use"; null when not set yet. */
  address: string | null;
  host: string | null;
  port: number | null;
  path: string;
  ssl: boolean;
  username: string;
}

interface AddedPhone {
  id: string;
  label: string;
  token: string;
  setup: SetupDetails;
}

/** The Phones section of the account guide; phase 4's phone-backup guide replaces it. */
const GUIDE_HREF = "/help/your-account#phones";

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="opds-copy-row">
      <span className="opds-copy-label">{label}</span>
      <code className="opds-copy-value">{value}</code>
      <Button variant="icon" title={t("profile.phones.copy", { label })} aria-label={t("profile.phones.copy", { label })} onClick={onCopy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
}

// Profile › My library › Phones (docs/photo-sync-plan.md, phase 2): each phone gets its
// own device token, shown once with the details to type into PhotoSync, and can be
// revoked. Backups only go into this member's personal library, and only from a
// network the administrator listed for phone sync.
export function PhonesSection() {
  const { t } = useTranslation();
  const [view, setView] = useState<PhonesView | null>(null);
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [added, setAdded] = useState<AddedPhone | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [pendingRevoke, setPendingRevoke] = useState<Phone | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api<PhonesView>("/api/profile/phones"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.phones.loadFailed"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch {
      /* clipboard unavailable — the value is still visible to copy by hand */
    }
  };

  const openAdd = () => {
    setLabel("");
    setAddError("");
    setAdded(null);
    setAddOpen(true);
  };

  const closeAdd = () => {
    setAddOpen(false);
    setAdded(null);
    setAddError("");
    setLabel("");
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setAddError("");
    try {
      const payload = await api<PhonesView & { added: AddedPhone }>("/api/profile/phones", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() })
      });
      setView(payload);
      setAdded(payload.added);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("profile.phones.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    setRevoking(true);
    setError("");
    try {
      setView(await api<PhonesView>(`/api/profile/phones/${pendingRevoke.id}`, { method: "DELETE" }));
      setPendingRevoke(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.phones.revokeFailed"));
      setPendingRevoke(null);
    } finally {
      setRevoking(false);
    }
  };

  if (!view) {
    return error ? <MessageBox tone="error" title={t("profile.phones.errorTitle")}>{error}</MessageBox> : null;
  }

  const phones = view.phones;
  const nameOf = (phone: Phone) => phone.label || t("profile.phones.unnamed");
  const setup = added?.setup;

  return (
    <section className="my-library-phones" aria-labelledby="my-library-phones-heading">
      <h3 id="my-library-phones-heading">{t("profile.phones.heading")}</h3>
      <p className="opds-intro">{t("profile.phones.intro")}</p>

      {error && <MessageBox tone="error" title={t("profile.phones.errorTitle")}>{error}</MessageBox>}

      {view.unavailable === "off" && (
        <MessageBox tone="info" title={t("profile.phones.unavailableTitle")}>{t("profile.phones.unavailableOff")}</MessageBox>
      )}

      {view.unavailable === null && (
        <div className="opds-actions">
          <Button variant="primary" onClick={openAdd} disabled={phones.length >= view.maxPhones}>
            <Plus size={16} aria-hidden="true" />
            {t("profile.phones.add")}
          </Button>
        </div>
      )}

      {phones.length > 0 && (
        <div className="opds-token-list">
          {phones.map((phone) => (
            <div className="opds-token-row" key={phone.id}>
              <div className="opds-token-meta">
                <strong>{nameOf(phone)}</strong>
                <span className="opds-intro">
                  {t("profile.phones.added", { date: formatDate(phone.createdAt) })}
                  {phone.lastSeen
                    ? t("profile.phones.lastSeen", { date: formatDate(phone.lastSeen) })
                    : t("profile.phones.neverSeen")}
                </span>
              </div>
              <Button
                variant="icon"
                danger
                title={t("profile.phones.revoke")}
                aria-label={t("profile.phones.revokeAria", { name: nameOf(phone) })}
                onClick={() => setPendingRevoke(phone)}
              >
                <Trash2 size={18} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {view.unavailable === null && phones.length === 0 && <p className="opds-intro">{t("profile.phones.none")}</p>}

      {addOpen && (
        <Modal
          variant="card"
          className="opds-token-modal"
          title={added ? t("profile.phones.addedTitle", { name: added.label }) : t("profile.phones.addTitle")}
          icon={<Smartphone size={22} />}
          busy={adding}
          onClose={closeAdd}
          onSubmit={added ? undefined : add}
        >
          {added && setup ? (
            <div className="opds-created">
              <MessageBox tone="success" title={t("profile.phones.copyNowTitle")}>{t("profile.phones.copyNowBody")}</MessageBox>
              <p className="opds-intro">{t("profile.phones.setupIntro")}</p>
              {setup.host && setup.port ? (
                <>
                  <CopyRow label={t("profile.phones.server")} value={setup.host} copied={copied === "host"} onCopy={() => copy("host", setup.host!)} />
                  <CopyRow label={t("profile.phones.port")} value={String(setup.port)} copied={copied === "port"} onCopy={() => copy("port", String(setup.port))} />
                </>
              ) : (
                <MessageBox tone="warning" title={t("profile.phones.noAddressTitle")}>{t("profile.phones.noAddressBody")}</MessageBox>
              )}
              <CopyRow label={t("profile.phones.path")} value={setup.path} copied={copied === "path"} onCopy={() => copy("path", setup.path)} />
              <div className="opds-copy-row">
                <span className="opds-copy-label">{t("profile.phones.ssl")}</span>
                <code className="opds-copy-value">{setup.ssl ? t("profile.phones.sslOn") : t("profile.phones.sslOff")}</code>
              </div>
              <CopyRow label={t("profile.phones.username")} value={setup.username} copied={copied === "user"} onCopy={() => copy("user", setup.username)} />
              <CopyRow label={t("profile.phones.password")} value={added.token} copied={copied === "token"} onCopy={() => copy("token", added.token)} />
              <p className="opds-intro">{t("profile.phones.homeOnly")}</p>
              <p className="opds-intro">
                <Trans
                  i18nKey="profile.phones.guide"
                  components={{ guide: <a href={GUIDE_HREF} onClick={(event) => followRoute(event, GUIDE_HREF)} /> }}
                />
              </p>
              <div className="modal-actions">
                <Button variant="primary" onClick={closeAdd}>{t("common.done")}</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="opds-intro">{t("profile.phones.nameIntro")}</p>
              <Field label={t("profile.phones.name")} value={label} onChange={setLabel} placeholder={t("profile.phones.namePlaceholder")} />
              {addError && <MessageBox tone="error" title={t("profile.phones.addFailed")}>{addError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeAdd} disabled={adding}>{t("common.cancel")}</Button>
                <Button variant="primary" type="submit" disabled={adding || !label.trim()}>
                  {adding ? t("profile.phones.adding") : t("profile.phones.add")}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title={t("profile.phones.revokeTitle", { name: nameOf(pendingRevoke) })}
          confirmLabel={t("profile.phones.revoke")}
          busyLabel={t("profile.phones.revoking")}
          danger
          busy={revoking}
          onConfirm={revoke}
          onCancel={() => setPendingRevoke(null)}
        >
          {t("profile.phones.revokeBody")}
        </ConfirmDialog>
      )}
    </section>
  );
}
