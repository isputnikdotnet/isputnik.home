import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Fingerprint,
  HelpCircle,
  House,
  KeyRound,
  Link2,
  Shield,
  type LucideIcon
} from "lucide-react";
import { Button } from "../../../../shared/Button";
import { PageSizeMenu, type PageSize } from "../../../../shared/PageSizeMenu";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { Tooltip } from "../../../../shared/Tooltip";
import { countryName, formatManagedDate } from "../../../../shared/utils";
import type { IpReputationEntry, LogEvent } from "../../types";
import { loginMethodLabel, loginResultLabel } from "./activityEvents";
import type { ActivitySort } from "./useRecentActivity";

// The Logins table proper. A row is the glanceable version — address, a method
// glyph, the result, a reputation light — and the arrow opens the full record
// underneath it, so nothing has to be squeezed into a column to be readable.

const METHOD_ICONS: Record<string, LucideIcon> = {
  "auth.login": KeyRound,
  "auth.passkey_login": Fingerprint,
  "auth.device_link_approved": Link2
};

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
  entry: IpReputationEntry | undefined
): { icon: LucideIcon; tone: string; title: string; filled: boolean } {
  if (isLocalAddress(ip)) {
    return { icon: House, tone: "local", title: "Local network — never looked up", filled: false };
  }
  if (!entry || typeof entry.score !== "number") {
    return { icon: Shield, tone: "unknown", title: "Not checked yet", filled: false };
  }
  const place = [countryName(entry.countryCode), entry.isp].filter(Boolean).join(" · ");
  const title = `${entry.score}% abuse confidence${place ? ` · ${place}` : ""}`;
  const tone = entry.score >= 50 ? "bad" : entry.score > 0 ? "watch" : "clean";
  return { icon: Shield, tone, title, filled: true };
}

export function LoginsTable({
  logs,
  total,
  pageSize,
  onPageSize,
  sort,
  dir,
  onSort,
  reputation,
  reputationConfigured,
  checkingIp,
  onCheck
}: {
  logs: LogEvent[];
  total: number;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  sort: ActivitySort;
  dir: SortDirection;
  onSort: (sort: ActivitySort, dir: SortDirection) => void;
  reputation: Record<string, IpReputationEntry>;
  reputationConfigured: boolean;
  checkingIp: string | null;
  onCheck: (ip: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const columnCount = reputationConfigured ? 6 : 5;

  return (
    <>
      <div className="status-table-title">
        <h3>Logins in this range</h3>
        <span className="login-table-tools">
          {total > 0 && <span>{total} {total === 1 ? "entry" : "entries"}</span>}
          <PageSizeMenu value={pageSize} onChange={onPageSize} />
        </span>
      </div>

      <div className="datagrid-wrap">
        <table className="datagrid login-table">
          <thead>
            <tr>
              <th className="col-expand"><span className="sr-only">Details</span></th>
              <SortHeader
                columns={[
                  { column: "ip", label: "IP address" },
                  { column: "user", label: "User" }
                ]}
                sort={sort}
                dir={dir}
                onChange={onSort}
              />
              <SortHeader column="event" label="Method" sort={sort} dir={dir} onChange={onSort} />
              <th>Result</th>
              {reputationConfigured && <th>Reputation</th>}
              <SortHeader column="time" label="Time" sort={sort} dir={dir} onChange={onSort} initial="desc" />
            </tr>
          </thead>
          <tbody>
            {logs.map((entry) => {
              const open = expanded === entry.id;
              const failed = loginResultLabel(entry.event) === "Failed";
              const MethodIcon = METHOD_ICONS[entry.event] ?? HelpCircle;
              // A failed attempt doesn't record which method was tried, so the
              // glyph needs a name of its own rather than the table's "—".
              const rawMethod = loginMethodLabel(entry.event);
              const methodLabel = rawMethod === "—" ? "Method not recorded" : rawMethod;
              const light = reputationLight(entry.ipAddress, entry.ipAddress ? reputation[entry.ipAddress] : undefined);
              const Light = light.icon;

              return [
                <tr key={entry.id} className={open ? "is-expanded" : undefined}>
                  <td className="col-expand">
                    <Button
                      variant="icon"
                      compact
                      aria-expanded={open}
                      aria-label={open ? "Hide details" : "Show details"}
                      title={open ? "Hide details" : "Show details"}
                      onClick={() => setExpanded(open ? null : entry.id)}
                    >
                      {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                    </Button>
                  </td>
                  <td>
                    <span className="datagrid-primary">
                      <strong>{entry.ipAddress ?? "No address"}</strong>
                      <small>{entry.actorName ?? "Unknown"}</small>
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
                    <span className={`status-badge ${failed ? "failed" : "completed"}`}>
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
    </>
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
  const ip = entry.ipAddress;
  const place = reputation ? [countryName(reputation.countryCode), reputation.isp].filter(Boolean).join(" · ") : "";

  return (
    <dl className="login-detail-grid">
      <div>
        <dt>User</dt>
        <dd>{entry.actorName ?? "Unknown — the address gave a name that has no account"}</dd>
      </div>
      <div>
        <dt>IP address</dt>
        <dd>{ip ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Method</dt>
        <dd>{loginMethodLabel(entry.event)}</dd>
      </div>
      <div>
        <dt>Result</dt>
        <dd>{loginResultLabel(entry.event)}</dd>
      </div>
      <div>
        <dt>When</dt>
        <dd>{formatManagedDate(entry.createdAt)}</dd>
      </div>
      <div>
        <dt>Event</dt>
        <dd><code>{entry.event}</code></dd>
      </div>
      <div className="login-detail-wide">
        <dt>Detail</dt>
        <dd>{entry.detail || "—"}</dd>
      </div>
      {reputationConfigured && (
        <div className="login-detail-wide">
          <dt>Reputation</dt>
          <dd>
            {isLocalAddress(ip) ? (
              "Local network — nothing is ever sent to AbuseIPDB for an address inside the house."
            ) : reputation && typeof reputation.score === "number" ? (
              <>
                {reputation.score}% abuse confidence
                {reputation.totalReports ? ` · ${reputation.totalReports.toLocaleString()} reports` : ""}
                {place ? ` · ${place}` : ""}
                {reputation.lastReportedAt ? ` · last reported ${formatManagedDate(reputation.lastReportedAt)}` : ""}
                {` · checked ${formatManagedDate(reputation.checkedAt)}`}
              </>
            ) : (
              <>
                Not checked yet.{" "}
                {ip && (
                  <Button variant="text" compact disabled={checking} onClick={() => onCheck(ip)}>
                    {checking ? "Checking…" : "Check with AbuseIPDB"}
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
