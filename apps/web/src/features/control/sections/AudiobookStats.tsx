import { BookOpen, Clock3, HardDrive, Library, Mic2, UserRound } from "lucide-react";
import { formatBytes } from "../../../shared/utils";
import type { PersonStatusStats, SystemStatus } from "../types";
import { StatusMetric, formatHours } from "./StatusMetric";

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
              <td><strong className="status-person-name">{person.name}</strong></td>
              <td className="col-num datagrid-muted">{person.bookCount}</td>
              <td className="col-num datagrid-muted">{formatHours(person.totalDurationSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One panel of Overview › Statistics. StatisticsSection owns the fetch, the
// heading and the media-type switch; this just draws the audiobook slice.
export function AudiobookStats({ status: systemStatus }: { status: SystemStatus }) {
  return (
    <>
        <div className="status-stack">
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
    </>
  );
}
