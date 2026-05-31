import { useState, useEffect } from "react";
import { Activity, BookOpen, Clock3, Database, HardDrive, Library, Mic2, RefreshCw, ScrollText, Ticket, UserRound, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate, formatBytes, formatUptime } from "../../../shared/utils";
import type { PersonStatusStats, SystemStatus } from "../types";

function formatHours(seconds: number) {
  if (seconds <= 0) return "0 hr";
  const hours = seconds / 3600;
  return `${hours >= 100 ? Math.round(hours).toLocaleString() : hours.toFixed(hours >= 10 ? 1 : 2)} hr`;
}

function StatusMetric({ icon: Icon, label, value, note }: { icon: LucideIcon; label: string; value: string; note?: string }) {
  return (
    <article className="status-metric">
      <span className="status-metric-icon" aria-hidden="true"><Icon size={18} /></span>
      <span className="status-metric-label">{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}

function PeopleTable({ people }: { people: PersonStatusStats[] }) {
  if (people.length === 0) {
    return <p className="status-empty">No books with this metadata yet.</p>;
  }

  return (
    <div className="datagrid-wrap">
      <table className="datagrid status-rank-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th className="col-num">Books</th>
            <th className="col-num">Hours</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person, index) => (
            <tr key={person.name}>
              <td className="datagrid-muted">#{index + 1}</td>
              <td>
                <strong className="status-person-name">{person.name}</strong>
              </td>
              <td className="col-num datagrid-muted">{person.bookCount}</td>
              <td className="col-num datagrid-muted">{formatHours(person.totalDurationSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusSection() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
  };

  useEffect(() => {
    loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to load status"));
  }, []);

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">System</p>
          <h1>Status</h1>
        </div>
        <button className="secondary-button compact-button" onClick={() => loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh status"))}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && <MessageBox tone="error" title="Status error">{error}</MessageBox>}

      {systemStatus && (
        <div className="status-stack">
          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Application</p>
                <h2>System</h2>
              </div>
              <div className="health-line">
                <span className="health-dot" aria-hidden="true"></span>
                <strong>{systemStatus.health}</strong>
                <span>Updated {formatManagedDate(systemStatus.generatedAt)}</span>
              </div>
            </div>
            <div className="status-grid">
              <StatusMetric icon={UsersRound} label="Users" value={String(systemStatus.users)} />
              <StatusMetric icon={Activity} label="Active sessions" value={String(systemStatus.activeSessions)} />
              <StatusMetric icon={Ticket} label="Active invites" value={String(systemStatus.activeInvites)} />
              <StatusMetric icon={ScrollText} label="Log entries" value={String(systemStatus.logEntries)} />
              <StatusMetric icon={Database} label="Database size" value={formatBytes(systemStatus.databaseBytes)} />
              <StatusMetric icon={Clock3} label="Server uptime" value={formatUptime(systemStatus.uptimeSeconds)} />
            </div>
          </section>

          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Catalog</p>
                <h2>Libraries & Books</h2>
              </div>
            </div>

            <div className="status-grid status-grid-four">
              <StatusMetric icon={Library} label="Total libraries" value={String(systemStatus.libraryStats.totalLibraries)} />
              <StatusMetric icon={BookOpen} label="Total books" value={String(systemStatus.libraryStats.totalBooks)} />
              <StatusMetric icon={HardDrive} label="Total size" value={formatBytes(systemStatus.libraryStats.totalSizeBytes)} />
              <StatusMetric icon={Clock3} label="Total hours" value={formatHours(systemStatus.libraryStats.totalDurationSeconds)} />
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Libraries</h3>
                <span>{systemStatus.libraryStats.libraries.length} total</span>
              </div>
              {systemStatus.libraryStats.libraries.length === 0 ? (
                <p className="status-empty">No audiobook libraries have been added yet.</p>
              ) : (
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>Library</th>
                        <th className="col-num">Books</th>
                        <th className="col-num">Size</th>
                        <th className="col-num">Hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {systemStatus.libraryStats.libraries.map((library) => (
                        <tr key={library.id}>
                          <td>
                            <div className="datagrid-primary">
                              <strong>{library.name}</strong>
                              <small>{formatBytes(library.totalSizeBytes)} on disk</small>
                            </div>
                          </td>
                          <td className="col-num datagrid-muted">{library.bookCount}</td>
                          <td className="col-num datagrid-muted">{formatBytes(library.totalSizeBytes)}</td>
                          <td className="col-num datagrid-muted">{formatHours(library.totalDurationSeconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">People</p>
                <h2>Top 10</h2>
              </div>
            </div>
            <div className="status-rank-grid">
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3><UserRound size={17} aria-hidden="true" /> Authors</h3>
                </div>
                <PeopleTable people={systemStatus.libraryStats.topAuthors} />
              </div>
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3><Mic2 size={17} aria-hidden="true" /> Narrators</h3>
                </div>
                <PeopleTable people={systemStatus.libraryStats.topNarrators} />
              </div>
            </div>
          </section>

          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Longest listens</p>
                <h2>Top 10 Books by Hour</h2>
              </div>
            </div>
            {systemStatus.libraryStats.longestBooks.length === 0 ? (
              <p className="status-empty">No audiobook durations are available yet.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Book</th>
                      <th>Library</th>
                      <th className="col-num">Hours</th>
                      <th className="col-num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {systemStatus.libraryStats.longestBooks.map((book, index) => (
                      <tr key={book.id}>
                        <td>
                          <div className="datagrid-primary">
                            <strong>{index + 1}. {book.title}</strong>
                            <small>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</small>
                          </div>
                        </td>
                        <td className="datagrid-muted">{book.libraryName}</td>
                        <td className="col-num datagrid-muted">{formatHours(book.totalDurationSeconds)}</td>
                        <td className="col-num datagrid-muted">{formatBytes(book.totalSizeBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
