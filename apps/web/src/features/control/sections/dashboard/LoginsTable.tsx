import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  Fingerprint,
  HelpCircle,
  House,
  KeyRound,
  Link2,
  Share2,
  Shield,
  ShieldCheck,
  SmartphoneNfc,
  type LucideIcon
} from "lucide-react";
import { Button } from "../../../../shared/Button";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { Tooltip } from "../../../../shared/Tooltip";
import { countryName, formatManagedDate } from "../../../../shared/utils";
import type { IpReputationEntry, LogEvent } from "../../types";
import { GUEST_VISIT_EVENT, isFailedLoginEvent, isGuestVisitEvent, loginMethodLabel, loginResultLabel } from "./activityEvents";
import type { ActivitySort } from "./useRecentActivity";

// The sign-ins table proper. A row is the glanceable version — address, a
// method glyph, the result, a reputation light — and the arrow opens the full
// record underneath it, so nothing has to be squeezed into a column to be
// readable. The heading above it belongs to whoever placed it: this shares a
// card with the devices table, and one tab strip names them both.

const METHOD_ICONS: Record<string, LucideIcon> = {
  "auth.login": KeyRound,
  "auth.passkey_login": Fingerprint,
  "auth.mfa_verified": ShieldCheck,
  "auth.mfa_failed": SmartphoneNfc,
  "auth.device_link_approved": Link2,
  [GUEST_VISIT_EVENT]: Share2
};

// A share-link visit has no account behind it by design, which is a different
// thing from a name the address gave that matched nobody.
function actorLabel(entry: LogEvent, t: TFunction<readonly ["common", "controlDash"], undefined>, long: boolean): string {
  if (entry.actorName) return entry.actorName;
  if (isGuestVisitEvent(entry.event)) return t("controlDash:loginsTable.guest");
  return long ? t("controlDash:loginsTable.unknownActor") : t("controlDash:loginsTable.unknown");
}

// Local addresses are the normal case in a house: never offer to send one to
// AbuseIPDB, which would learn nothing and tell us nothing.
export function isLocalAddress(ip: string | null): boolean {
  if (!ip) return true;
  const value = (ip.startsWith("::ffff:") ? ip.slice(7) : ip).toLowerCase();
  return (
    value === "::1" ||
    value.startsWith("127.") ||
    value.startsWith("10.") ||
    value.startsWith("192.168.") ||
    value.startsWith("169.254.") ||
    value.startsWith("fe80:") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  );
}

// One shield, and the colour is the signal: green clean, amber some history, red
// abusive — on the same thresholds the escalation policy uses. Colour alone never
// carries meaning here; the score and place are in the tooltip and the accessible
// name, and spelled out in full in the opened record.
function reputationLight(
  ip: string | null,
  entry: IpReputationEntry | undefined,
  t: TFunction<readonly ["common", "controlDash"], undefined>
): { icon: LucideIcon; tone: string; title: string; filled: boolean } {
  if (isLocalAddress(ip)) {
    return { icon: House, tone: "local", title: t("controlDash:loginsTable.localNever"), filled: false };
  }
  if (!entry || typeof entry.score !== "number") {
    return { icon: Shield, tone: "unknown", title: t("controlDash:loginsTable.notCheckedYet"), filled: false };
  }
  const place = [countryName(entry.countryCode), entry.isp].filter(Boolean).join(" · ");
  const title = `${t("controlDash:loginsTable.abuseConfidence", { score: entry.score })}${place ? ` · ${place}` : ""}`;
  const tone = entry.score >= 50 ? "bad" : entry.score > 0 ? "watch" : "clean";
  return { icon: Shield, tone, title, filled: true };
}

export function LoginsTable({
  logs,
  sort,
  dir,
  onSort,
  reputation,
  reputationConfigured,
  checkingIp,
  onCheck
}: {
  logs: LogEvent[];
  sort: ActivitySort;
  dir: SortDirection;
  onSort: (sort: ActivitySort, dir: SortDirection) => void;
  reputation: Record<string, IpReputationEntry>;
  reputationConfigured: boolean;
  checkingIp: string | null;
  onCheck: (ip: string) => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const columnCount = reputationConfigured ? 6 : 5;

  return (
    <div className="datagrid-wrap">
      <table className="datagrid login-table">
        <thead>
          <tr>
            <th className="col-expand"><span className="sr-only">{t("controlDash:table.details")}</span></th>
            <SortHeader
              columns={[
                { column: "ip", label: t("controlDash:table.ipAddress") },
                { column: "user", label: t("controlDash:table.user") }
              ]}
              sort={sort}
              dir={dir}
              onChange={onSort}
            />
            <SortHeader column="event" label={t("controlDash:table.method")} sort={sort} dir={dir} onChange={onSort} />
            <th>{t("controlDash:table.result")}</th>
            {reputationConfigured && <th>{t("controlDash:table.reputation")}</th>}
            <SortHeader column="time" label={t("controlDash:table.time")} sort={sort} dir={dir} onChange={onSort} initial="desc" />
          </tr>
        </thead>
        <tbody>
          {logs.map((entry) => {
            const open = expanded === entry.id;
            const failed = isFailedLoginEvent(entry.event);
            const guest = isGuestVisitEvent(entry.event);
            const MethodIcon = METHOD_ICONS[entry.event] ?? HelpCircle;
            // A failed attempt doesn't record which method was tried, so the
            // glyph needs a name of its own rather than the table's "—".
            const rawMethod = loginMethodLabel(entry.event);
            const methodLabel = rawMethod === "—" ? t("controlDash:loginsTable.methodNotRecorded") : rawMethod;
            const light = reputationLight(entry.ipAddress, entry.ipAddress ? reputation[entry.ipAddress] : undefined, t);
            const Light = light.icon;

            return [
              <tr key={entry.id} className={open ? "is-expanded" : undefined}>
                <td className="col-expand">
                  <Button
                    variant="icon"
                    compact
                    aria-expanded={open}
                    aria-label={open ? t("controlDash:loginsTable.hideDetails") : t("controlDash:loginsTable.showDetails")}
                    title={open ? t("controlDash:loginsTable.hideDetails") : t("controlDash:loginsTable.showDetails")}
                    onClick={() => setExpanded(open ? null : entry.id)}
                  >
                    {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                  </Button>
                </td>
                <td>
                  <span className="datagrid-primary">
                    <strong>{entry.ipAddress ?? t("controlDash:loginsTable.noAddress")}</strong>
                    <small>{actorLabel(entry, t, false)}</small>
                  </span>
                </td>
                {/* The hover target is the whole cell, not the 18px glyph: an
                    icon that small is easy to hover past. */}
                <td className="col-glyph">
                  <Tooltip label={methodLabel} className="col-glyph-hit">
                    <span className="login-method-icon" role="img" aria-label={methodLabel}>
                      <MethodIcon size={18} aria-hidden="true" />
                    </span>
                  </Tooltip>
                </td>
                <td>
                  <span className={`status-badge ${failed ? "failed" : guest ? "idle" : "completed"}`}>
                    {loginResultLabel(entry.event)}
                  </span>
                </td>
                {reputationConfigured && (
                  <td className="col-glyph">
                    <Tooltip label={light.title} className="col-glyph-hit">
                      <span className={`reputation-light ${light.tone}`} role="img" aria-label={light.title}>
                        <Light size={18} fill={light.filled ? "currentColor" : "none"} aria-hidden="true" />
                      </span>
                    </Tooltip>
                  </td>
                )}
                <td className="datagrid-muted">{formatManagedDate(entry.createdAt)}</td>
              </tr>,
              open && (
                <tr key={`${entry.id}-details`} className="login-detail-row">
                  <td colSpan={columnCount}>
                    <LoginDetails
                      entry={entry}
                      reputation={entry.ipAddress ? reputation[entry.ipAddress] : undefined}
                      reputationConfigured={reputationConfigured}
                      checking={entry.ipAddress === checkingIp}
                      onCheck={onCheck}
                    />
                  </td>
                </tr>
              )
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function LoginDetails({
  entry,
  reputation,
  reputationConfigured,
  checking,
  onCheck
}: {
  entry: LogEvent;
  reputation: IpReputationEntry | undefined;
  reputationConfigured: boolean;
  checking: boolean;
  onCheck: (ip: string) => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const ip = entry.ipAddress;
  const place = reputation ? [countryName(reputation.countryCode), reputation.isp].filter(Boolean).join(" · ") : "";

  return (
    <dl className="login-detail-grid">
      <div>
        <dt>{t("controlDash:table.user")}</dt>
        <dd>{actorLabel(entry, t, true)}</dd>
      </div>
      <div>
        <dt>{t("controlDash:table.ipAddress")}</dt>
        <dd>{ip ?? t("controlDash:loginsTable.notRecorded")}</dd>
      </div>
      <div>
        <dt>{t("controlDash:table.method")}</dt>
        <dd>{loginMethodLabel(entry.event)}</dd>
      </div>
      <div>
        <dt>{t("controlDash:table.result")}</dt>
        <dd>{loginResultLabel(entry.event)}</dd>
      </div>
      <div>
        <dt>{t("controlDash:table.when")}</dt>
        <dd>{formatManagedDate(entry.createdAt)}</dd>
      </div>
      <div>
        <dt>{t("controlDash:table.event")}</dt>
        <dd><code>{entry.event}</code></dd>
      </div>
      <div className="login-detail-wide">
        <dt>{t("controlDash:table.detail")}</dt>
        <dd>{entry.detail || "—"}</dd>
      </div>
      {reputationConfigured && (
        <div className="login-detail-wide">
          <dt>{t("controlDash:table.reputation")}</dt>
          <dd>
            {isLocalAddress(ip) ? (
              t("controlDash:loginsTable.localReputation")
            ) : reputation && typeof reputation.score === "number" ? (
              <>
                {t("controlDash:loginsTable.abuseConfidence", { score: reputation.score })}
                {reputation.totalReports ? ` · ${t("controlDash:loginsTable.reports", { count: reputation.totalReports })}` : ""}
                {place ? ` · ${place}` : ""}
                {reputation.lastReportedAt ? ` · ${t("controlDash:loginsTable.lastReported", { date: formatManagedDate(reputation.lastReportedAt) })}` : ""}
                {` · ${t("controlDash:loginsTable.checkedAt", { date: formatManagedDate(reputation.checkedAt) })}`}
              </>
            ) : (
              <>
                {t("controlDash:loginsTable.notCheckedDot")}{" "}
                {ip && (
                  <Button variant="text" compact disabled={checking} onClick={() => onCheck(ip)}>
                    {checking ? t("controlDash:loginsTable.checking") : t("controlDash:loginsTable.checkWith")}
                  </Button>
                )}
              </>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}
