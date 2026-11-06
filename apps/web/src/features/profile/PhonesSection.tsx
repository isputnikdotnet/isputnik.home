import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Plus, Smartphone, Trash2 } from "lucide-react";
import { api } from "../../api";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatDate, formatDateTime } from "../../shared/dates";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { formatBytes } from "../../shared/utils";

/** What went wrong last (server: sync/status.ts). The detail is never a file name. */
type ProblemCode = "not_listed" | "proxy" | "type" | "too_large" | "quota" | "disk_full" | "incomplete" | "checksum" | "library_unavailable" | "server_error";

interface PhoneStatus {
  lastContact: string | null;
  lastReceived: string | null;
  day: { files: number; bytes: number };
  total: { files: number; bytes: number };
  /** `current` until the phone backs up again (server: resolved_at). */
  problem: { code: ProblemCode; detail: string | null; at: string; current?: boolean } | null;
  /** No contact for a week (server: STALE_DAYS). */
  stale?: boolean;
}

/** How full the personal library is against the member's limit; null with no limit. */
interface LibraryUsage {
  usedBytes: number;
  limitBytes: number;
  nearLimit: boolean;
  atLimit: boolean;
}

/** Days since a date, for "no contact for N days". */
const daysSince = (iso: string) => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

interface Phone {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  status: PhoneStatus | null;
}

interface PhonesView {
  unavailable: "off" | "no_library" | null;
  maxPhones: number;
  usage?: LibraryUsage | null;
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

const GUIDE_HREF = "/help/phone-backup";

/** One phone's backup at a glance: last contact and file, today and in all, and the
 *  last problem — as a notice until the phone backs up again, as a line after. A week
 *  without contact, and a library near its limit, are said here too (phase 5). */
function PhoneStatusLines({ status, createdAt, usage }: { status: PhoneStatus; createdAt: string; usage: LibraryUsage | null }) {
  const { t } = useTranslation();
  const PROBLEM_TEXT: Record<ProblemCode, string> = {
    not_listed: t("profile.phones.problem.not_listed", { detail: status.problem?.detail ?? "" }),
    proxy: t("profile.phones.problem.proxy"),
    type: t("profile.phones.problem.type", { detail: status.problem?.detail ?? "" }),
    too_large: t("profile.phones.problem.too_large"),
    quota: t("profile.phones.problem.quota"),
    disk_full: t("profile.phones.problem.disk_full"),
    incomplete: t("profile.phones.problem.incomplete"),
    checksum: t("profile.phones.problem.checksum"),
    library_unavailable: t("profile.phones.problem.library_unavailable"),
    server_error: t("profile.phones.problem.server_error")
  };
  const problem = status.problem;
  // The server says when it is over; an older server's answer is read the old way.
  const current = problem && (problem.current ?? (!status.lastReceived || problem.at > status.lastReceived));
  return (
    <>
      <span className="opds-intro">
        {status.lastContact ? t("profile.phones.lastContact", { date: formatDateTime(status.lastContact) }) : t("profile.phones.noContact")}
        {" · "}
        {status.lastReceived ? t("profile.phones.lastFile", { date: formatDateTime(status.lastReceived) }) : t("profile.phones.noFile")}
      </span>
      {status.total.files > 0 && (
        <span className="opds-intro">
          {t("profile.phones.day", { files: t("profile.phones.files", { count: status.day.files }), bytes: formatBytes(status.day.bytes) })}
          {" · "}
          {t("profile.phones.total", { files: t("profile.phones.files", { count: status.total.files }), bytes: formatBytes(status.total.bytes) })}
        </span>
      )}
      {status.stale && (
        <MessageBox
          tone="warning"
          title={t("profile.phones.staleTitle", { count: daysSince(status.lastContact ?? createdAt) })}
        >
          {status.lastContact
            ? t("profile.phones.staleBody", { date: formatDateTime(status.lastContact) })
            : t("profile.phones.staleNever", { date: formatDate(createdAt) })}
        </MessageBox>
      )}
      {usage?.nearLimit && !usage.atLimit && (
        <span className="opds-intro phone-near-limit">
          {t("profile.phones.nearLimit", {
            percent: Math.floor((usage.usedBytes / usage.limitBytes) * 100),
            limit: formatBytes(usage.limitBytes)
          })}
        </span>
      )}
      {problem && current && (
        <MessageBox tone="warning" title={t("profile.phones.problemTitle", { date: formatDateTime(problem.at) })}>
          {PROBLEM_TEXT[problem.code]}
        </MessageBox>
      )}
      {problem && !current && (
        <span className="opds-intro">
          {t("profile.phones.problemEarlier", { date: formatDateTime(problem.at), problem: PROBLEM_TEXT[problem.code] })}
        </span>
      )}
    </>
  );
}

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
                <span className="opds-intro">{t("profile.phones.added", { date: formatDate(phone.createdAt) })}</span>
                {phone.status && <PhoneStatusLines status={phone.status} createdAt={phone.createdAt} usage={view?.usage ?? null} />}
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
