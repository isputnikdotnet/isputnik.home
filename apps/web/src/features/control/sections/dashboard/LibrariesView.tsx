import { useMemo, useState } from "react";
import { BookOpen, HardDrive, Headphones, Image, Mic2, UserRound, Video, type LucideIcon } from "lucide-react";
import { KpiCard } from "../../../../shared/KpiCard";
import { Pager } from "../../../../shared/Pager";
import { formatBytes } from "../../../../shared/utils";
import type { SystemStatus } from "../../types";
import { formatHours } from "../StatusMetric";

// Overview › Dashboard › Libraries — what is in the catalogue, all media types on
// one page. This was Statistics: three panels behind a type switch, each with
// its own "Libraries" table, its own size card and its own top-ten of the biggest
// files. One page now: four cards (one per type, plus the disk), every library
// in one table with its share of the storage drawn beside it, the people who make
// up the collection, and the one biggest-files list that earns its place — the
// gallery's, where a single video can outweigh a thousand photos. The book ones
// went: the storage bars answer the question they were asked.

type Kind = "audiobook" | "ebook" | "gallery";

const KIND: Record<Kind, { label: string; icon: LucideIcon }> = {
  audiobook: { label: "Audiobooks", icon: Headphones },
  ebook: { label: "Ebooks", icon: BookOpen },
  gallery: { label: "Gallery", icon: Image }
};

interface LibraryRow {
  id: string;
  kind: Kind;
  name: string;
  items: number;
  sizeBytes: number;
  /** What the type measures beyond a count: hours of audio, hours of video, or nothing. */
  detail: string;
}

const PAGE_SIZE = 10;
// The three side-by-side rank tables share one screen with the cards and the
// libraries table, so each shows the top five — enough to name the names without
// turning a glance into a scroll.
const RANK_ROWS = 5;

function pageOf<T>(rows: T[], page: number): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  return { rows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, totalPages };
}

function RankTable({
  rows,
  empty,
  columns
}: {
  rows: { key: string; name: string; sub?: string; cells: string[] }[];
  empty: string;
  columns: string[];
}) {
  if (rows.length === 0) return <p className="status-empty">{empty}</p>;
  return (
    <div className="datagrid-wrap">
      <table className="datagrid status-rank-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            {columns.map((column) => (
              <th key={column} className="col-num">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key}>
              <td className="datagrid-muted">{index + 1}</td>
              <td>
                <span className="datagrid-primary">
                  <strong className="status-person-name">{row.name}</strong>
                  {row.sub && <small>{row.sub}</small>}
                </span>
              </td>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="col-num datagrid-muted">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LibrariesView({ status }: { status: SystemStatus }) {
  const audio = status.libraryStats;
  const ebooks = status.ebookStats;
  const gallery = status.galleryStats;
  const [page, setPage] = useState(1);

  // Every library of every type in one list, biggest first — the order that
  // answers "where is the disk going".
  const libraries = useMemo<LibraryRow[]>(() => {
    const rows: LibraryRow[] = [
      ...audio.libraries.map((library) => ({
        id: `audiobook-${library.id}`,
        kind: "audiobook" as const,
        name: library.name,
        items: library.bookCount,
        sizeBytes: library.totalSizeBytes,
        detail: formatHours(library.totalDurationSeconds)
      })),
      ...ebooks.libraries.map((library) => ({
        id: `ebook-${library.id}`,
        kind: "ebook" as const,
        name: library.name,
        items: library.bookCount,
        sizeBytes: library.totalSizeBytes,
        detail: "—"
      })),
      ...gallery.libraries.map((library) => ({
        id: `gallery-${library.id}`,
        kind: "gallery" as const,
        name: library.name,
        items: library.itemCount,
        sizeBytes: library.totalSizeBytes,
        detail: `${library.photoCount.toLocaleString()} photos · ${library.videoCount.toLocaleString()} videos`
      }))
    ];
    return rows.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  }, [audio, ebooks, gallery]);
  const largest = libraries[0]?.sizeBytes ?? 1;
  const paged = pageOf(libraries, page);

  // Authors across both book types, merged by name — the same person is often
  // on the shelf as an ebook and in the ears as an audiobook.
  const authors = useMemo(() => {
    const byName = new Map<string, { audio: number; ebook: number; hours: number }>();
    for (const person of audio.topAuthors) {
      const entry = byName.get(person.name) ?? { audio: 0, ebook: 0, hours: 0 };
      entry.audio += person.bookCount;
      entry.hours += person.totalDurationSeconds;
      byName.set(person.name, entry);
    }
    for (const person of ebooks.topAuthors) {
      const entry = byName.get(person.name) ?? { audio: 0, ebook: 0, hours: 0 };
      entry.ebook += person.bookCount;
      byName.set(person.name, entry);
    }
    return [...byName.entries()]
      .map(([name, entry]) => ({ name, total: entry.audio + entry.ebook, ...entry }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, RANK_ROWS);
  }, [audio.topAuthors, ebooks.topAuthors]);

  const totalBytes = audio.totalSizeBytes + ebooks.totalSizeBytes + gallery.totalSizeBytes;
  const totalLibraries = audio.totalLibraries + ebooks.totalLibraries + gallery.totalLibraries;

  return (
    <div className="status-stack compact-tables">
      <section className="status-block">
        <div className="kpi-cards">
          <KpiCard
            icon={Headphones}
            tone="info"
            label="Audiobooks"
            value={audio.totalBooks.toLocaleString()}
            context={`${formatHours(audio.totalDurationSeconds)} · ${formatBytes(audio.totalSizeBytes)} · ${audio.totalLibraries} ${audio.totalLibraries === 1 ? "library" : "libraries"}`}
          />
          <KpiCard
            icon={BookOpen}
            tone="success"
            label="Ebooks"
            value={ebooks.totalBooks.toLocaleString()}
            context={`${formatBytes(ebooks.totalSizeBytes)} · ${ebooks.totalLibraries} ${ebooks.totalLibraries === 1 ? "library" : "libraries"}`}
          />
          <KpiCard
            icon={Image}
            tone="warning"
            label="Photos & videos"
            value={gallery.totalItems.toLocaleString()}
            context={`${gallery.totalPhotos.toLocaleString()} photos · ${gallery.totalVideos.toLocaleString()} videos · ${formatHours(gallery.totalDurationSeconds)} of video`}
          />
          <KpiCard
            icon={HardDrive}
            tone="info"
            label="On disk"
            value={formatBytes(totalBytes)}
            context={`${totalLibraries} ${totalLibraries === 1 ? "library" : "libraries"} across ${[audio, ebooks, gallery].filter((type) => type.totalLibraries > 0).length} media types`}
          />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>Libraries</h3>
            <span>{libraries.length} {libraries.length === 1 ? "library" : "libraries"} · biggest first, with its share of the storage</span>
          </div>
          {libraries.length === 0 ? (
            <p className="status-empty">No libraries have been added yet.</p>
          ) : (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid locations-table">
                  <thead>
                    <tr>
                      <th>Library</th>
                      <th>Storage</th>
                      <th className="col-num">Items</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((library) => {
                      const Icon = KIND[library.kind].icon;
                      return (
                        <tr key={library.id}>
                          <td>
                            <span className="location-cell">
                              <Icon size={17} aria-hidden="true" className="signins-device-icon" />
                              <span className="datagrid-primary">
                                <strong>{library.name}</strong>
                                <small>{KIND[library.kind].label}</small>
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="conn-cell">
                              <span className="conn-count">{formatBytes(library.sizeBytes)}</span>
                              <span className="conn-track" aria-hidden="true">
                                <span
                                  className="conn-fill"
                                  style={{ width: `${Math.max(3, Math.round((library.sizeBytes / largest) * 100))}%` }}
                                />
                              </span>
                            </span>
                          </td>
                          <td className="col-num">{library.items.toLocaleString()}</td>
                          <td className="datagrid-muted">{library.detail}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={paged.page} totalPages={paged.totalPages} onChange={setPage} label="Library pages" />
            </>
          )}
        </div>

        <div className="libraries-rank-grid">
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><UserRound size={17} aria-hidden="true" /> Top authors</h3>
              <span>Audiobooks &amp; ebooks</span>
            </div>
            <RankTable
              columns={["Titles", "Of which"]}
              empty="No books with author metadata yet."
              rows={authors.map((author) => ({
                key: author.name,
                name: author.name,
                cells: [
                  author.total.toLocaleString(),
                  [author.audio ? `${author.audio} audio` : null, author.ebook ? `${author.ebook} ebook` : null]
                    .filter(Boolean)
                    .join(" · ")
                ]
              }))}
            />
          </div>
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><Mic2 size={17} aria-hidden="true" /> Top narrators</h3>
              <span>By hours read</span>
            </div>
            <RankTable
              columns={["Books", "Hours"]}
              empty="No audiobooks with narrator metadata yet."
              rows={audio.topNarrators.slice(0, RANK_ROWS).map((person) => ({
                key: person.name,
                name: person.name,
                cells: [person.bookCount.toLocaleString(), formatHours(person.totalDurationSeconds)]
              }))}
            />
          </div>
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><Video size={17} aria-hidden="true" /> Biggest files</h3>
              <span>By size</span>
            </div>
            <RankTable
              columns={["Size"]}
              empty="No photos or videos yet."
              rows={gallery.largestItems.slice(0, RANK_ROWS).map((item) => ({
                key: item.id,
                name: item.title,
                sub: [item.kind === "video" ? "Video" : "Photo", item.libraryName].join(" · "),
                cells: [formatBytes(item.totalSizeBytes)]
              }))}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
