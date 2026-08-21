import { useEffect, useState } from "react";
import { HelpCircle, Laptop, Monitor, Smartphone, Tablet, type LucideIcon } from "lucide-react";
import { api } from "../../../../api";
import { KpiCard } from "../../../../shared/KpiCard";
import { MessageBox } from "../../../../shared/MessageBox";
import { PageSizeMenu, usePageSize } from "../../../../shared/PageSizeMenu";
import { Pager } from "../../../../shared/Pager";
import { SortHeader, type SortDirection } from "../../../../shared/SortHeader";
import { Tooltip } from "../../../../shared/Tooltip";
import { formatManagedDate, relativeTime } from "../../../../shared/utils";
import type { DeviceType, ManagedSession } from "../../types";

// Overview › Dashboard › Devices. Every device signed in to the house: the linked
// displays that outlive any browser session, and each phone, tablet and computer
// with a live session. The counts are the glance; the table is the audit.

const TYPES: { value: DeviceType; label: string; plural: string; icon: LucideIcon; tone: "info" | "success" | "warning" | "danger" }[] = [
  { value: "display", label: "Display", plural: "Displays", icon: Monitor, tone: "info" },
  { value: "phone", label: "Phone", plural: "Phones", icon: Smartphone, tone: "success" },
  { value: "tablet", label: "Tablet", plural: "Tablets", icon: Tablet, tone: "warning" },
  { value: "computer", label: "Computer", plural: "Computers", icon: Laptop, tone: "info" }
];

const UNKNOWN = { label: "Unknown", plural: "Unknown", icon: HelpCircle };

function typeInfo(type: DeviceType) {
  return TYPES.find((entry) => entry.value === type) ?? { ...UNKNOWN, value: "unknown" as const, tone: "info" as const };
}

type DeviceSort = "name" | "type" | "person" | "seen";

export function DevicesView() {
  const [sessions, setSessions] = useState<ManagedSession[] | null>(null);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<DeviceSort>("seen");
  const [dir, setDir] = useState<SortDirection>("desc");
  const [pageSize, choosePageSize] = usePageSize("isputnik.devices.pageSize");
  const [page, setPage] = useState(1);

  useEffect(() => {
    api<{ sessions: ManagedSession[] }>("/api/sessions")
      .then((payload) => setSessions(payload.sessions))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load devices"));
  }, []);

  if (error) {
    return <MessageBox tone="error" title="Unable to load devices">{error}</MessageBox>;
  }
  if (!sessions) return null;

  const counts = sessions.reduce<Record<string, number>>((acc, session) => {
    acc[session.type] = (acc[session.type] ?? 0) + 1;
    return acc;
  }, {});
  const unknown = counts.unknown ?? 0;

  // Sorting is over one page of rows, so it stays in the browser: the list is a
  // household's devices, not a log.
  const sorted = [...sessions].sort((a, b) => {
    const factor = dir === "asc" ? 1 : -1;
    switch (sort) {
      case "name":
        return factor * a.name.localeCompare(b.name);
      case "type":
        return factor * typeInfo(a.type).label.localeCompare(typeInfo(b.type).label);
      case "person":
        return factor * a.displayName.localeCompare(b.displayName);
      default:
        return factor * (Date.parse(a.lastSeen) - Date.parse(b.lastSeen));
    }
  });

  // Sorting and paging both happen here rather than on the server: this is a
  // household's devices, a list that fits in one response, not a log.
  const totalPages = Math.max(1, Math.ceil(sorted.length / Number(pageSize)));
  const current = Math.min(page, totalPages);
  const rows = sorted.slice((current - 1) * Number(pageSize), current * Number(pageSize));

  const sortBy = (next: DeviceSort, nextDir: SortDirection) => {
    setSort(next);
    setDir(nextDir);
    setPage(1);
  };

  return (
    <div className="status-stack">
      <section className="status-block">
        <div className="kpi-cards">
          {TYPES.map((entry) => (
            <KpiCard
              key={entry.value}
              icon={entry.icon}
              tone={entry.tone}
              label={entry.plural}
              value={String(counts[entry.value] ?? 0)}
              context={entry.value === "display" ? "Linked TVs and screens" : `Signed in on a ${entry.label.toLowerCase()}`}
            />
          ))}
        </div>

        {unknown > 0 && (
          <p className="status-empty">
            {unknown} {unknown === 1 ? "device doesn't" : "devices don't"} say what they are — they're in the table below.
          </p>
        )}

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Registered devices</h3>
            <span className="login-table-tools">
              <span>{sessions.length} {sessions.length === 1 ? "device" : "devices"}</span>
              <PageSizeMenu
                value={pageSize}
                onChange={(next) => {
                  choosePageSize(next);
                  setPage(1);
                }}
              />
            </span>
          </div>

          {rows.length > 0 ? (
            <>
            <div className="datagrid-wrap">
              <table className="datagrid device-table">
                <thead>
                  <tr>
                    <SortHeader column="type" label="Type" sort={sort} dir={dir} onChange={sortBy} />
                    <SortHeader column="name" label="Device" sort={sort} dir={dir} onChange={sortBy} />
                    <SortHeader column="person" label="Person" sort={sort} dir={dir} onChange={sortBy} />
                    <th>IP address</th>
                    <SortHeader column="seen" label="Last seen" sort={sort} dir={dir} onChange={sortBy} initial="desc" />
                    <th>Signed in until</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((session) => {
                    const info = typeInfo(session.type);
                    const Icon = info.icon;
                    return (
                      <tr key={session.id}>
                        <td className="col-glyph">
                          <Tooltip label={info.label} className="col-glyph-hit">
                            <span className="device-type-icon" role="img" aria-label={info.label}>
                              <Icon size={18} aria-hidden="true" />
                            </span>
                          </Tooltip>
                        </td>
                        <td>
                          <span className="datagrid-primary">
                            <strong>
                              {session.name}
                              {session.current && <span className="device-current"> · this one</span>}
                            </strong>
                            {/* The agent line only earns its place when the owner
                                has renamed the device; otherwise it repeats the
                                name it just supplied. */}
                            <small>{session.name === session.agent ? `Signed in ${formatManagedDate(session.createdAt)}` : session.agent}</small>
                          </span>
                        </td>
                        <td>
                          <span className="datagrid-primary">
                            <strong>{session.displayName}</strong>
                            <small>{session.email}</small>
                          </span>
                        </td>
                        <td className="datagrid-muted">{session.ipAddress ?? "—"}</td>
                        <td className="datagrid-muted">{relativeTime(session.lastSeen)}</td>
                        <td className="datagrid-muted">{formatManagedDate(session.expiresAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={current} totalPages={totalPages} onChange={setPage} label="Device pages" />
            </>
          ) : (
            <p className="status-empty">No devices are signed in.</p>
          )}
        </div>
      </section>
    </div>
  );
}
