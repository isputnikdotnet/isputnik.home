import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Smartphone, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { formatBytes, formatManagedDate } from "../../../shared/utils";

/** Only problems about the phone or the server reach an admin (server: ADMIN_PROBLEMS). */
type AdminProblem = "not_listed" | "proxy" | "quota" | "disk_full" | "library_unavailable";

interface MemberPhone {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  problem: { code: AdminProblem; detail: string | null; at: string; current?: boolean } | null;
  stale?: boolean;
  /** Photo Sync phase 6: libraries linked on their Phone backups tab. */
  links?: Array<{ libraryId: string; name: string; counts: boolean }>;
}

interface MemberPhonesView {
  library: { id: string; sizeBytes: number } | null;
  usage?: { usedBytes: number; limitBytes: number; nearLimit: boolean; atLimit: boolean } | null;
  phones: MemberPhone[];
}

const daysSince = (iso: string) => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

// A member's page › Account (docs/photo-sync-plan.md, phase 4): their personal
// library's size and the phones that back up into it — name, added, last contact,
// and a problem only when it is about the phone or the server. Never what is in the
// library or what a phone sent: the library is theirs alone (decision 3).
export function MemberPhonesCard({ userId, name }: { userId: string; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [view, setView] = useState<MemberPhonesView | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<MemberPhone | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await api<MemberPhonesView>(`/api/photo-sync/members/${encodeURIComponent(userId)}`));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:member.phones.loadFailed"));
    }
  }, [t, userId]);
  useEffect(() => { void load(); }, [load]);

  const revoke = async () => {
    if (!pending) return;
    setRevoking(true);
    setRevokeError("");
    try {
      setView(await api<MemberPhonesView>(`/api/photo-sync/members/${encodeURIComponent(userId)}/phones/${encodeURIComponent(pending.id)}`, { method: "DELETE" }));
      setPending(null);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : t("controlAdmin:member.phones.revokeFailed"));
    } finally {
      setRevoking(false);
    }
  };

  // Nothing to say about someone with no library and no phones.
  if (view && !view.library && view.phones.length === 0) return null;

  const phoneName = (phone: MemberPhone) => phone.label || t("controlAdmin:member.phones.unnamed");
  const problemText = (problem: NonNullable<MemberPhone["problem"]>) => {
    const words: Record<AdminProblem, string> = {
      not_listed: t("controlAdmin:member.phones.problem.not_listed", { detail: problem.detail ?? "" }),
      proxy: t("controlAdmin:member.phones.problem.proxy"),
      quota: t("controlAdmin:member.phones.problem.quota"),
      disk_full: t("controlAdmin:member.phones.problem.disk_full"),
      library_unavailable: t("controlAdmin:member.phones.problem.library_unavailable")
    };
    const key = problem.current === false ? "controlAdmin:member.phones.problemEarlier" : "controlAdmin:member.phones.problemAt";
    return t(key, { problem: words[problem.code], date: formatManagedDate(problem.at) });
  };

  return (
    <section className="member-card" aria-labelledby="member-phones-title">
      <h2 id="member-phones-title">
        <Smartphone size={17} aria-hidden="true" />
        {t("controlAdmin:member.phones.title")}
      </h2>
      <p className="access-muted">{t("controlAdmin:member.phones.hint")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:member.phones.loadFailed")}>{error}</MessageBox>}
      {view === null && !error && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
      {view && (
        <>
          <p>
            {view.library
              ? t("controlAdmin:member.phones.size", { size: formatBytes(view.library.sizeBytes) })
              : t("controlAdmin:member.phones.none")}
          </p>
          {view.usage?.nearLimit && (
            <MessageBox tone="warning" title={t(view.usage.atLimit ? "controlAdmin:member.phones.atLimit" : "controlAdmin:member.phones.nearLimit")}>
              {t("controlAdmin:member.phones.limitBody", { used: formatBytes(view.usage.usedBytes), limit: formatBytes(view.usage.limitBytes) })}
            </MessageBox>
          )}
          {view.phones.length === 0 ? (
            <p className="access-muted">{t("controlAdmin:member.phones.noPhones")}</p>
          ) : (
            <ul className="member-phones">
              {view.phones.map((phone) => (
                <li key={phone.id}>
                  <span className="member-phones-meta">
                    <strong>{phoneName(phone)}</strong>
                    <small className="access-muted">
                      {t("controlAdmin:member.phones.added", { date: formatManagedDate(phone.createdAt) })}
                      {" · "}
                      {phone.lastSeen
                        ? t("controlAdmin:member.phones.lastContact", { date: formatManagedDate(phone.lastSeen) })
                        : t("controlAdmin:member.phones.noContact")}
                    </small>
                    {phone.stale && (
                      <small className="member-phones-problem">
                        {t("controlAdmin:member.phones.stale", { count: daysSince(phone.lastSeen ?? phone.createdAt) })}
                      </small>
                    )}
                    {phone.problem && (
                      <small className={phone.problem.current === false ? "access-muted" : "member-phones-problem"}>{problemText(phone.problem)}</small>
                    )}
                    {phone.links?.map((link) => (
                      <small key={link.libraryId} className={link.counts ? "access-muted" : "member-phones-problem"}>
                        {t(link.counts ? "controlAdmin:phoneSyncPage.skipsLibrary" : "controlAdmin:phoneSyncPage.skipsLibraryNoAccess", { library: link.name })}
                      </small>
                    ))}
                  </span>
                  <Button
                    variant="icon"
                    danger
                    title={t("controlAdmin:member.phones.revoke")}
                    aria-label={t("controlAdmin:member.phones.revokeAria", { name: phoneName(phone) })}
                    onClick={() => { setRevokeError(""); setPending(phone); }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {pending && (
        <ConfirmDialog
          title={t("controlAdmin:member.phones.revokeTitle", { name: phoneName(pending), member: name })}
          confirmLabel={t("controlAdmin:member.phones.revoke")}
          busyLabel={t("controlAdmin:member.phones.revoking")}
          danger
          busy={revoking}
          error={revokeError}
          onConfirm={() => void revoke()}
          onCancel={() => setPending(null)}
        >
          {t("controlAdmin:member.phones.revokeBody", { member: name })}
        </ConfirmDialog>
      )}
    </section>
  );
}
