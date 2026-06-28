import { useState, useEffect } from "react";
import { BookOpen, FileText, HardDrive, Library, RefreshCw, UserRound } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatBytes } from "../../../shared/utils";
import type { EbookPersonStatusStats, SystemStatus } from "../types";
import { StatusMetric } from "./StatusMetric";

function AuthorsTable({ people }: { people: EbookPersonStatusStats[] }) {
  if (people.length === 0) {
    return <p className="status-empty">No ebooks with author metadata yet.</p>;
  }

  return (
    <div className="datagrid-wrap">
      <table className="datagrid status-rank-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th className="col-num">Books</th>
          </tr>
        </thead>
        <tbody>
          {people.map((person, index) => (
            <tr key={person.name}>
              <td className="datagrid-muted">#{index + 1}</td>
              <td><strong className="status-person-name">{person.name}</strong></td>
              <td className="col-num datagrid-muted">{person.bookCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EbookStatsSection() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
  };

  useEffect(() => {
    loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to load stats"));
  }, []);

  const stats = systemStatus?.ebookStats;

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Ebook stats</h1>
        </div>
        <Button variant="secondary" compact onClick={() => loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh stats"))}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error && <MessageBox tone="error" title="Stats error">{error}</MessageBox>}

      {stats && (
        <div className="status-stack">
          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Catalog</p>
                <h2>Libraries & Books</h2>
              </div>
            </div>

            <div className="status-grid status-grid-four">
              <StatusMetric icon={Library} label="Total libraries" value={String(stats.totalLibraries)} />
              <StatusMetric icon={BookOpen} label="Total books" value={String(stats.totalBooks)} />
              <StatusMetric icon={HardDrive} label="Total size" value={formatBytes(stats.totalSizeBytes)} />
              <StatusMetric icon={FileText} label="File formats" value={String(stats.formats.length)} />
            </div>

            <div className="status-subsection">
              <div className="status-table-title">
                <h3>Libraries</h3>
                <span>{stats.libraries.length} total</span>
              </div>
              {stats.libraries.length === 0 ? (
                <p className="status-empty">No ebook libraries have been added yet.</p>
              ) : (
                <div className="datagrid-wrap">
                  <table className="datagrid">
                    <thead>
                      <tr>
                        <th>Library</th>
                        <th className="col-num">Books</th>
                        <th className="col-num">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.libraries.map((library) => (
                        <tr key={library.id}>
                          <td>
                            <div className="datagrid-primary">
                              <strong>{library.name}</strong>
                              <small>{formatBytes(library.totalSizeBytes)} on disk</small>
                            </div>
                          </td>
                          <td className="col-num datagrid-muted">{library.bookCount}</td>
                          <td className="col-num datagrid-muted">{formatBytes(library.totalSizeBytes)}</td>
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
                <p className="eyebrow">Authors & Formats</p>
                <h2>Breakdown</h2>
              </div>
            </div>
            <div className="status-rank-grid">
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3><UserRound size={17} aria-hidden="true" /> Top 10 Authors</h3>
                </div>
                <AuthorsTable people={stats.topAuthors} />
              </div>
              <div className="status-subsection">
                <div className="status-table-title">
                  <h3><FileText size={17} aria-hidden="true" /> Formats</h3>
                </div>
                {stats.formats.length === 0 ? (
                  <p className="status-empty">No ebook files have been catalogued yet.</p>
                ) : (
                  <div className="datagrid-wrap">
                    <table className="datagrid status-rank-table">
                      <thead>
                        <tr>
                          <th>Format</th>
                          <th className="col-num">Files</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.formats.map((row) => (
                          <tr key={row.format}>
                            <td><strong className="status-person-name">{row.format}</strong></td>
                            <td className="col-num datagrid-muted">{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="status-block">
            <div className="status-block-head">
              <div>
                <p className="eyebrow">Largest files</p>
                <h2>Top 10 Books by Size</h2>
              </div>
            </div>
            {stats.largestBooks.length === 0 ? (
              <p className="status-empty">No ebooks have been catalogued yet.</p>
            ) : (
              <div className="datagrid-wrap">
                <table className="datagrid">
                  <thead>
                    <tr>
                      <th>Book</th>
                      <th>Library</th>
                      <th>Formats</th>
                      <th className="col-num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.largestBooks.map((book, index) => (
                      <tr key={book.id}>
                        <td>
                          <div className="datagrid-primary">
                            <strong>{index + 1}. {book.title}</strong>
                            <small>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</small>
                          </div>
                        </td>
                        <td className="datagrid-muted">{book.libraryName}</td>
                        <td className="datagrid-muted">{book.formats.length > 0 ? book.formats.join(", ") : "—"}</td>
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
