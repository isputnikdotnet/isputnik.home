import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ScrollText, Smartphone } from "lucide-react";
import { api } from "../../../api";
import { followRoute, memberHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { formatManagedDate } from "../../../shared/utils";
import { ControlSectionHead } from "../ControlSectionHead";
import { logsHref } from "../links";
import { PhoneSyncNetworksCard } from "./PhoneSyncNetworksCard";

/** Only problems about the phone or the server reach an admin (server: ADMIN_PROBLEMS). */
type AdminProblem = "not_listed" | "proxy" | "quota" | "disk_full" | "library_unavailable";

interface OverviewPhone {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeen: string | null;
  lastIp: string | null;
  /** The phone-sync network its last address falls in (label, else the range). */
  network: string | null;
  member: { id: string; name: string };
  problem: { code: AdminProblem; detail: string | null; at: string; current: boolean } | null;
  stale: boolean;
  nearLimit: boolean;
  atLimit: boolean;
  /** Refused from an address on no list: the /24 to offer as the fix. */
  suggestedRange: string | null;
}

const daysSince = (iso: string) => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

// Security › Phone sync (docs/photo-sync-plan.md, phase 5): where phones may back up
// from, and every member's phones on one page — whose, last contact, the address and
// network it came from, and what is wrong now, with the fix one click away when a
// phone is refused from an address no network holds (the VPN typed without its /24
// was the live run that asked for this). What happened, and when, is Overview › Logs
// (the photo_sync events); this page is the state. The privacy line of phase 4 holds:
// never counts of what was sent, never files or file types.
export function PhoneSyncSection() {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [phones, setPhones] = useState<OverviewPhone[] | null>(null);
  const [error, setError] = useState("");
  const [networksKey, setNetworksKey] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState("");

  const load = useCallback(async () => {
    const view = await api<{ phones: OverviewPhone[] }>("/api/photo-sync/phones");
    setPhones(view.phones);
    setError("");
  }, []);

  const loadQuietly = useCallback(async () => {
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed"));
    }
  }, [load, t]);
  useEffect(() => { void loadQuietly(); }, [loadQuietly]);

  const phoneName = (phone: OverviewPhone) => phone.label || t("controlAdmin:member.phones.unnamed");

  const addRange = async (phone: OverviewPhone) => {
    if (!phone.suggestedRange) return;
    setAdding(phone.id);
    setAddError("");
    try {
      await api("/api/photo-sync/networks", {
        method: "POST",
        body: JSON.stringify({ cidr: phone.suggestedRange, label: t("controlAdmin:phoneSyncPage.rangeLabel", { phone: phoneName(phone) }) })
      });
      setNetworksKey((key) => key + 1);
      await loadQuietly();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.addRangeFailed"));
    } finally {
      setAdding(null);
    }
  };

  const problemText = (problem: NonNullable<OverviewPhone["problem"]>) => {
    const words: Record<AdminProblem, string> = {
      not_listed: t("controlAdmin:member.phones.problem.not_listed", { detail: problem.detail ?? "" }),
      proxy: t("controlAdmin:member.phones.problem.proxy"),
      quota: t("controlAdmin:member.phones.problem.quota"),
      disk_full: t("controlAdmin:member.phones.problem.disk_full"),
      library_unavailable: t("controlAdmin:member.phones.problem.library_unavailable")
    };
    return words[problem.code];
  };

  /** What is wrong now, most pressing first; a quiet word when nothing is. */
  const states = (phone: OverviewPhone): Array<{ text: string; warn: boolean }> => {
    const out: Array<{ text: string; warn: boolean }> = [];
    if (phone.problem?.current) {
      out.push({ text: t("controlAdmin:member.phones.problemAt", { problem: problemText(phone.problem), date: formatManagedDate(phone.problem.at) }), warn: true });
    }
    if (phone.stale) out.push({ text: t("controlAdmin:phoneSyncPage.stateStale", { count: daysSince(phone.lastSeen ?? phone.createdAt) }), warn: true });
    if (phone.atLimit) out.push({ text: t("controlAdmin:phoneSyncPage.stateAtLimit"), warn: true });
    else if (phone.nearLimit) out.push({ text: t("controlAdmin:phoneSyncPage.stateNearLimit"), warn: true });
    if (out.length === 0) {
      out.push({ text: phone.lastSeen ? t("controlAdmin:phoneSyncPage.stateOk") : t("controlAdmin:phoneSyncPage.stateWaiting"), warn: false });
    }
    if (phone.problem && !phone.problem.current) {
      out.push({ text: t("controlAdmin:member.phones.problemEarlier", { problem: problemText(phone.problem), date: formatManagedDate(phone.problem.at) }), warn: false });
    }
    return out;
  };

  return (
    <>
      <ControlSectionHead
        section="phoneSync"
        icon={<Smartphone size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:phoneSyncPage.description")}
      >
        <RefreshButton
          onRefresh={async () => {
            setNetworksKey((key) => key + 1);
            try {
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:phoneSyncPage.loadFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      <PhoneSyncNetworksCard refreshKey={networksKey} onChange={() => void loadQuietly()} />

      <section className="security-block compact-tables" aria-labelledby="phone-sync-phones-heading">
        <div className="security-network-head">
          <h2 id="phone-sync-phones-heading">{t("controlAdmin:phoneSyncPage.phonesHeading")}</h2>
          <p className="section-description">{t("controlAdmin:phoneSyncPage.phonesDesc")}</p>
        </div>
        <p>
          <a href={logsHref({ event: "photo_sync" })} onClick={(event) => followRoute(event, logsHref({ event: "photo_sync" }))}>
            <ScrollText size={14} aria-hidden="true" /> {t("controlAdmin:phoneSyncPage.allInLogs")}
          </a>
        </p>

        {error && <MessageBox tone="error" title={t("controlAdmin:phoneSyncPage.loadFailed")}>{error}</MessageBox>}
        {addError && <MessageBox tone="error" title={t("controlAdmin:phoneSyncPage.addRangeFailed")}>{addError}</MessageBox>}
        {phones === null && !error && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
        {phones && phones.length === 0 && <p className="access-muted">{t("controlAdmin:phoneSyncPage.noPhones")}</p>}

        {phones && phones.length > 0 && (
          <div className="datagrid-wrap">
            <table className="datagrid phone-sync-phones">
              <thead>
                <tr>
                  <th>{t("controlAdmin:phoneSyncPage.colMember")}</th>
                  <th>{t("controlAdmin:phoneSyncPage.colPhone")}</th>
                  <th>{t("controlAdmin:phoneSyncPage.colContact")}</th>
                  <th>{t("controlAdmin:phoneSyncPage.colFrom")}</th>
                  <th>{t("controlAdmin:phoneSyncPage.colState")}</th>
                  <th className="col-actions">{t("controlAdmin:security.thActions")}</th>
                </tr>
              </thead>
              <tbody>
                {phones.map((phone) => (
                  <tr key={phone.id}>
                    <td><a href={memberHref(phone.member.id)} onClick={(event) => followRoute(event, memberHref(phone.member.id))}>{phone.member.name}</a></td>
                    <td>{phoneName(phone)}</td>
                    <td className="datagrid-muted">
                      {phone.lastSeen ? formatManagedDate(phone.lastSeen) : t("controlAdmin:phoneSyncPage.never")}
                    </td>
                    <td className="datagrid-muted">
                      {phone.lastIp ? (
                        <>
                          <code>{phone.lastIp}</code>
                          {" · "}
                          {phone.network ?? t("controlAdmin:phoneSyncPage.noNetwork")}
                        </>
                      ) : "—"}
                    </td>
                    <td>
                      {states(phone).map((state) => (
                        <div key={state.text} className={state.warn ? "member-phones-problem" : "datagrid-muted"}>{state.text}</div>
                      ))}
                    </td>
                    <td className="col-actions phone-sync-actions">
                      {phone.suggestedRange && (
                        <Button
                          variant="secondary"
                          title={t("controlAdmin:phoneSyncPage.addRangeTitle", { range: phone.suggestedRange })}
                          disabled={adding !== null}
                          onClick={() => void addRange(phone)}
                        >
                          <Plus size={15} aria-hidden="true" />
                          {adding === phone.id
                            ? t("controlAdmin:phoneSyncPage.addingRange")
                            : t("controlAdmin:phoneSyncPage.addRange", { range: phone.suggestedRange })}
                        </Button>
                      )}
                      <a
                        href={logsHref({ event: "photo_sync", q: phoneName(phone) })}
                        onClick={(event) => followRoute(event, logsHref({ event: "photo_sync", q: phoneName(phone) }))}
                        aria-label={t("controlAdmin:phoneSyncPage.seeInLogsAria", { phone: phoneName(phone) })}
                      >
                        {t("controlAdmin:phoneSyncPage.seeInLogs")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
