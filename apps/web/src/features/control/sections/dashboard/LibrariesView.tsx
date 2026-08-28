import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FolderOpen, HardDrive, Headphones, Image, Mic2, UserRound, Video, type LucideIcon } from "lucide-react";
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
//
// The four rank tables pair off two by two rather than sitting in one row of
// three-and-a-bit: people above (who wrote it, who read it aloud), places on
// disk below (what is heaviest, where the photos pile up). Three columns left
// each table too narrow for a name and a number once the fourth arrived.

type Kind = "audiobook" | "ebook" | "gallery";

const KIND_ICON: Record<Kind, LucideIcon> = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: Image
};

const KIND_LABEL_KEYS: Record<Kind, "audiobooks" | "ebooks" | "gallery"> = {
  audiobook: "audiobooks",
  ebook: "ebooks",
  gallery: "gallery"
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
// The four rank tables share one screen with the cards and the libraries table,
// so each shows the top five — enough to name the names without turning a glance
// into a scroll.
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
  const { t } = useTranslation(["common", "controlDash"]);
  if (rows.length === 0) return <p className="status-empty">{empty}</p>;
  return (
    <div className="datagrid-wrap">
      <table className="datagrid status-rank-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("controlDash:table.name")}</th>
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
  const { t } = useTranslation(["common", "controlDash"]);
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
            label={t("controlDash:libs.audiobooks")}
            value={audio.totalBooks.toLocaleString()}
            context={`${formatHours(audio.totalDurationSeconds)} · ${formatBytes(audio.totalSizeBytes)} · ${t("controlDash:libs.libraryCount", { count: audio.totalLibraries })}`}
          />
          <KpiCard
            icon={BookOpen}
            tone="success"
            label={t("controlDash:libs.ebooks")}
            value={ebooks.totalBooks.toLocaleString()}
            context={`${formatBytes(ebooks.totalSizeBytes)} · ${t("controlDash:libs.libraryCount", { count: ebooks.totalLibraries })}`}
          />
          <KpiCard
            icon={Image}
            tone="warning"
            label={t("controlDash:libs.photosVideos")}
            value={gallery.totalItems.toLocaleString()}
            context={`${t("controlDash:libs.photos", { count: gallery.totalPhotos })} · ${t("controlDash:libs.videos", { count: gallery.totalVideos })} · ${t("controlDash:libs.ofVideo", { hours: formatHours(gallery.totalDurationSeconds) })}`}
          />
          <KpiCard
            icon={HardDrive}
            tone="info"
            label={t("controlDash:libs.onDisk")}
            value={formatBytes(totalBytes)}
            context={`${t("controlDash:libs.libraryCount", { count: totalLibraries })} · ${t("controlDash:libs.acrossTypes", { count: [audio, ebooks, gallery].filter((type) => type.totalLibraries > 0).length })}`}
          />
        </div>

        <div className="status-subsection">
          <div className="status-table-title">
            <h3>{t("controlDash:libs.librariesTitle")}</h3>
            <span>{t("controlDash:libs.tableSummary", { count: libraries.length })}</span>
          </div>
          {libraries.length === 0 ? (
            <p className="status-empty">{t("controlDash:libs.noLibraries")}</p>
          ) : (
            <>
              <div className="datagrid-wrap">
                <table className="datagrid locations-table">
                  <thead>
                    <tr>
                      <th>{t("controlDash:table.library")}</th>
                      <th>{t("controlDash:table.storage")}</th>
                      <th className="col-num">{t("controlDash:table.items")}</th>
                      <th>{t("controlDash:table.detail")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((library) => {
                      const Icon = KIND_ICON[library.kind];
                      return (
                        <tr key={library.id}>
                          <td>
                            <span className="location-cell">
                              <Icon size={17} aria-hidden="true" className="signins-device-icon" />
                              <span className="datagrid-primary">
                                <strong>{library.name}</strong>
                                <small>{t(`controlDash:libs.${KIND_LABEL_KEYS[library.kind]}`)}</small>
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
              <Pager page={paged.page} totalPages={paged.totalPages} onChange={setPage} label={t("controlDash:pagers.library")} />
            </>
          )}
        </div>

        <div className="libraries-rank-grid">
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><UserRound size={17} aria-hidden="true" /> {t("controlDash:libs.topAuthors")}</h3>
              <span>{t("controlDash:libs.topAuthorsNote")}</span>
            </div>
            <RankTable
              columns={[t("controlDash:table.titles"), t("controlDash:table.ofWhich")]}
              empty={t("controlDash:libs.noAuthors")}
              rows={authors.map((author) => ({
                key: author.name,
                name: author.name,
                cells: [
                  author.total.toLocaleString(),
                  [
                    author.audio ? t("controlDash:libs.audioN", { count: author.audio }) : null,
                    author.ebook ? t("controlDash:libs.ebookN", { count: author.ebook }) : null
                  ]
                    .filter(Boolean)
                    .join(" · ")
                ]
              }))}
            />
          </div>
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><Mic2 size={17} aria-hidden="true" /> {t("controlDash:libs.topNarrators")}</h3>
              <span>{t("controlDash:libs.topNarratorsNote")}</span>
            </div>
            <RankTable
              columns={[t("controlDash:table.books"), t("controlDash:table.hours")]}
              empty={t("controlDash:libs.noNarrators")}
              rows={audio.topNarrators.slice(0, RANK_ROWS).map((person) => ({
                key: person.name,
                name: person.name,
                cells: [person.bookCount.toLocaleString(), formatHours(person.totalDurationSeconds)]
              }))}
            />
          </div>
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><Video size={17} aria-hidden="true" /> {t("controlDash:libs.biggestFiles")}</h3>
              <span>{t("controlDash:libs.biggestFilesNote")}</span>
            </div>
            <RankTable
              columns={[t("controlDash:table.size")]}
              empty={t("controlDash:libs.noGalleryItems")}
              rows={gallery.largestItems.slice(0, RANK_ROWS).map((item) => ({
                key: item.id,
                name: item.title,
                sub: [item.kind === "video" ? t("controlDash:libs.video") : t("controlDash:libs.photo"), item.libraryName].join(" · "),
                cells: [formatBytes(item.totalSizeBytes)]
              }))}
            />
          </div>
          <div className="status-subsection">
            <div className="status-table-title">
              <h3><FolderOpen size={17} aria-hidden="true" /> {t("controlDash:libs.fullestFolders")}</h3>
              <span>{t("controlDash:libs.fullestFoldersNote")}</span>
            </div>
            <RankTable
              columns={[t("controlDash:table.photos")]}
              empty={t("controlDash:libs.noGalleryItems")}
              rows={gallery.fullestFolders.slice(0, RANK_ROWS).map((row) => ({
                // Library and folder together: two libraries can each hold a "2004".
                key: `${row.libraryName}/${row.folder}`,
                // The folder's own name leads; the path above it is context, and a
                // file sitting at the library root has no folder name to show.
                name: row.folder ? row.folder.slice(row.folder.lastIndexOf("/") + 1) : t("controlDash:libs.libraryRoot"),
                sub: [
                  row.folder.includes("/") ? row.folder.slice(0, row.folder.lastIndexOf("/")) : row.libraryName,
                  row.videoCount ? t("controlDash:libs.videoN", { count: row.videoCount }) : null
                ]
                  .filter(Boolean)
                  .join(" · "),
                cells: [row.photoCount.toLocaleString()]
              }))}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
