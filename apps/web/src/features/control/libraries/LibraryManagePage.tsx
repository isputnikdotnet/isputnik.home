import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { controlHref, followRoute, type ControlSection } from "../../../router";
import { ControlBackBar } from "../ControlBackBar";
import { initialParam, librariesHref } from "../links";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import i18n from "../../../i18n";
import { tabLabel } from "../nav";
import {
  TYPE_ICON,
  accessSummary,
  capabilityLabels,
  formatCount,
  formatLibrarySize,
  languageLabel,
  modeLabel,
  phoneLinkable,
  roleLabel,
  rowTypeLabel,
  scanStatusLabel,
  typeLabel,
  libraryTypeFilter,
  type ManagedLibrary
} from "./managed-library";
import { LibraryStatus } from "./LibraryStatus";

// One library's page, under Library › Libraries at /control/libraries/<id>: a page
// of one thing, which drops the tab row and links back to the list. Everything about
// the library is in four sections (owner, 2026-11-19) — General, Access, Scanning,
// Advanced — each a list of what can be set there, one row per setting saying what it is set to
// now, with Edit opening that one setting; and under the rows, the facts that belong
// to the section (what used to be a separate Details card). Every option that can be
// changed has a row of its own: none is to be found only inside another's dialog.
// LibrariesSection owns the data and the dialogs; this is the page around them.

/** Which setting the Edit dialog shows. */
export type LibraryEditTab =
  | "name" | "video"
  | "access"
  | "upload" | "scanning" | "encoding" | "progress" | "backsides" | "phones";

interface Row {
  key: string;
  title: string;
  /** What it is set to now, or — where that is not one value — what it is for. */
  body: ReactNode;
  action?: ReactNode;
}

export function LibraryManagePage({
  library,
  ownerLabel,
  scanSources,
  extensions,
  scanning,
  videoEngineDown,
  onEdit,
  onMembers,
  onScanRules,
  onFaces,
  onRescan,
  onDelete
}: {
  library: ManagedLibrary;
  ownerLabel: string;
  scanSources: string;
  extensions: string;
  scanning: boolean;
  videoEngineDown: boolean;
  onEdit: (tab: LibraryEditTab) => void;
  onMembers: () => void;
  onScanRules: () => void;
  onFaces: () => void;
  onRescan: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const TypeIcon = TYPE_ICON[library.type];
  const listHref = librariesHref(libraryTypeFilter(initialParam("type")));
  const books = library.type === "audiobook" || library.type === "ebook";
  const gallery = library.type === "gallery";
  const video = library.type === "video";
  const edit = (tab: LibraryEditTab) => <EditButton onClick={() => onEdit(tab)} />;

  // The shared sets this type is organized with (Library › Organization).
  const organizing: ControlSection[] = books ? ["categories", "tags"] : gallery ? ["tags"] : ["genres"];
  const organizingBody = books
    ? t("control:libraries.manage.organizingBooks")
    : gallery ? t("control:libraries.manage.organizingGallery") : t("control:libraries.manage.organizingVideo");

  // ── General: what the library is and where it is.
  const general: Row[] = [
    {
      key: "name",
      title: t("control:libraries.manage.nameTitle"),
      body: library.name,
      // A system library keeps the name the app gave it.
      action: library.role ? undefined : edit("name")
    },
    video
      ? {
          key: "video",
          title: t("control:libraries.manage.videoTitle"),
          body: t("control:libraries.manage.videoValue", {
            folder: library.folder || t("control:libraries.notConfigured"),
            language: languageLabel(library.defaultLanguage ?? "en", i18n.resolvedLanguage ?? "en")
          }),
          action: edit("video")
        }
      : {
          key: "folder",
          title: t("control:libraries.manage.folderTitle"),
          // Where a library reads from is chosen when it is made, and not changed after.
          body: <code>{library.sourcePath ?? t("control:libraries.pathHidden")}</code>
        },
    {
      key: "organizing",
      title: t("control:libraries.manage.organizingTitle"),
      body: organizingBody,
      action: (
        <span className="library-manage-links">
          {organizing.map((section) => {
            const href = controlHref(section);
            return (
              <a key={section} className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
                {tabLabel(section)}
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            );
          })}
        </span>
      )
    }
  ];
  const generalFacts: Fact[] = [
    { label: t("control:libraries.fieldType"), value: rowTypeLabel(library) || typeLabel(library.type) },
    { label: t("control:libraries.fieldFiles"), value: formatCount(library.fileCount) },
    { label: t("control:libraries.fieldSize"), value: formatLibrarySize(library.totalSizeBytes) },
    { label: t("control:libraries.fieldCreated"), value: formatManagedDate(library.createdAt) },
    { label: t("control:libraries.fieldUpdated"), value: formatManagedDate(library.updatedAt) }
  ];

  // ── Access: whose it is and who may open it.
  const access: Row[] = [
    {
      key: "access",
      title: t("control:libraries.manage.accessTitle"),
      body: t("control:libraries.manage.accessBody", { access: accessSummary(library), owner: ownerLabel }),
      action: edit("access")
    }
  ];
  // A personal library has no grants to give; a system one is the app's.
  if (!library.personal && !library.role) {
    access.push({
      key: "members",
      title: t("control:libraries.manage.membersTitle"),
      body: t("control:libraries.manage.membersBody"),
      action: <EditButton onClick={onMembers} />
    });
  }
  const capabilities = capabilityLabels(library);
  const accessFacts: Fact[] = [
    { label: t("control:libraries.fieldYourRole"), value: roleLabel(library.myRole) },
    {
      label: t("control:libraries.fieldCapabilities"),
      value: capabilities.length > 0 ? (
        <span className="library-info-chips">
          {capabilities.map((capability) => <span key={capability} className="library-info-chip">{capability}</span>)}
        </span>
      ) : t("control:libraries.role.none")
    },
    ...(gallery ? [{
      label: t("control:libraries.fieldSystem"),
      value: library.role === "inbox" ? t("control:libraries.systemInbox") : library.role === "app-files" ? t("control:libraries.systemAppFiles") : t("control:libraries.systemNo")
    }] : [])
  ];

  // ── Scanning: how the folder is read into the catalogue — where details come from,
  // how folder and file names are read, and what the scan does with what it finds —
  // with how the last scan went. A video library is read by the video app, so it has
  // the facts and no settings.
  const scanningRows: Row[] = [];
  if (!video) {
    scanningRows.push({
      key: "scanning",
      title: t("control:libraries.manage.scanningTitle"),
      body: gallery
        ? t("control:libraries.manage.scanningBodyGallery", { sources: scanSources })
        : t("control:libraries.manage.scanningBody", { sources: scanSources }),
      action: edit("scanning")
    });
  }
  if (books) {
    scanningRows.push({
      key: "layout",
      title: t("control:libraries.manage.layoutTitle"),
      body: t("control:libraries.manage.layoutBody"),
      action: <EditButton onClick={onScanRules} />
    });
  }
  if (library.type === "audiobook") {
    scanningRows.push({
      key: "encoding",
      title: t("control:libraries.tagEncodingFieldLabel"),
      body: library.settings?.tagEncoding ?? t("control:libraries.tagEncodingNone"),
      action: edit("encoding")
    });
  }
  if (gallery) {
    scanningRows.push({
      key: "backsides",
      title: t("control:libraries.backSides.title"),
      body: t("control:libraries.manage.backSidesBody"),
      action: edit("backsides")
    });
  }
  if (gallery && !library.personal) {
    scanningRows.push({
      key: "faces",
      title: t("control:libraries.manage.facesTitle"),
      body: t("control:libraries.manage.facesBody"),
      action: <EditButton onClick={onFaces} />
    });
  }
  const scanningFacts: Fact[] = [
    { label: t("control:libraries.fieldStatus"), value: <span className={`status-badge ${library.scanStatus}`}>{scanStatusLabel(library.scanStatus)}</span> },
    ...(library.engine?.metadata
      ? [{ label: t("control:libraries.fieldDetails"), value: <LibraryStatus library={library} scanning={false} videoEngineDown={false} /> }]
      : []),
    { label: t("control:libraries.fieldLastScanned"), value: library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : t("control:libraries.notYet") }
  ];

  // ── Advanced: how files are taken in, and the rest. A video library's files are the
  // video app's own, so it has none here.
  const advanced: Row[] = [];
  if (!video) {
    advanced.push(
      {
        key: "upload",
        title: t("control:libraries.manage.uploadTitle"),
        body: t("control:libraries.manage.uploadValue", {
          mode: modeLabel(library.mode ?? "managed"),
          extensions,
          limit: library.settings?.maxUploadMB != null ? t("control:libraries.uploadLimitValue", { mb: library.settings.maxUploadMB }) : t("control:libraries.uploadLimitDefault")
        }),
        action: edit("upload")
      }
    );
  }
  if (library.type === "audiobook") {
    advanced.push({
      key: "progress",
      title: t("control:libraries.progressTracking"),
      body: library.settings?.progressMode === "episodic" ? t("control:libraries.progressEpisodic") : t("control:libraries.progressLinear"),
      action: edit("progress")
    });
  }
  if (phoneLinkable(library)) {
    advanced.push({
      key: "phones",
      title: t("control:libraries.manage.phonesTitle"),
      body: t("control:libraries.manage.phonesBody"),
      action: edit("phones")
    });
  }

  const headFacts = [
    rowTypeLabel(library),
    library.fileCount != null ? t("control:libraries.contentsFiles", { count: library.fileCount, formatted: formatCount(library.fileCount) }) : null,
    library.totalSizeBytes != null ? formatLibrarySize(library.totalSizeBytes) : null
  ].filter(Boolean).join(" · ");

  return (
    <div className="library-manage-page">
      <ControlBackBar section="libraries" list={{ href: listHref, label: tabLabel("libraries") }} />
      <div className="section-head admin-section-head library-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <TypeIcon size={30} />
          </span>
          <div className="admin-heading-copy">
            <h1>{library.name}</h1>
            <p className="section-description library-manage-facts">
              {headFacts && <span>{headFacts}</span>}
              <LibraryStatus library={library} scanning={scanning} videoEngineDown={videoEngineDown} />
            </p>
          </div>
        </div>
        <div className="row-actions">
          <Button variant="secondary" disabled={scanning} onClick={onRescan}>
            <RefreshCw size={16} aria-hidden="true" />
            {scanning ? t("control:libraries.rescanningTitle") : t("control:libraries.manage.rescan")}
          </Button>
        </div>
      </div>

      {library.role && (
        <MessageBox tone="info" title={t("control:libraries.systemNoteTitle")}>{t("control:libraries.systemNoteBody")}</MessageBox>
      )}

      <ManageSection id="general" title={t("control:libraries.manage.generalTitle")} rows={general} facts={generalFacts} />
      <ManageSection id="access" title={t("control:libraries.manage.accessSectionTitle")} rows={access} facts={accessFacts} />
      <ManageSection id="scanning" title={t("control:libraries.manage.scanningSectionTitle")} rows={scanningRows} facts={scanningFacts} />
      {advanced.length > 0 && (
        <ManageSection id="advanced" title={t("control:libraries.manage.advancedTitle")} rows={advanced} />
      )}

      {/* A system library is made and removed by the app, never here. */}
      {!library.role && (
        <section className="library-manage-card library-manage-danger" aria-labelledby="library-manage-delete">
          <h2 id="library-manage-delete">{t("control:libraries.deleteTitle")}</h2>
          <p className="muted">{t("control:libraries.manage.deleteBody")}</p>
          <div className="row-actions">
            <Button variant="danger" onClick={onDelete}>
              <Trash2 size={15} aria-hidden="true" />
              {t("control:libraries.manage.deleteAction")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

interface Fact {
  label: string;
  value: ReactNode;
}

/** One section of the page: its settings, then the facts that go with them. */
function ManageSection({ id, title, rows, facts = [] }: { id: string; title: string; rows: Row[]; facts?: Fact[] }) {
  const headingId = `library-manage-${id}`;
  return (
    <section className="library-manage-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {rows.length > 0 && (
        <ul className="library-manage-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <div>
                <strong>{row.title}</strong>
                <span>{row.body}</span>
              </div>
              {row.action}
            </li>
          ))}
        </ul>
      )}
      {facts.length > 0 && (
        <dl className={`library-manage-factlist${rows.length === 0 ? " is-alone" : ""}`}>
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function EditButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation(["control"]);
  return (
    <Button variant="secondary" compact onClick={onClick}>
      <Pencil size={14} aria-hidden="true" />
      {t("control:libraries.manage.edit")}
    </Button>
  );
}
