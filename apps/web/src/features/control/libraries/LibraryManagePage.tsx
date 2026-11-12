import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { controlHref, followRoute, followBack, type ControlSection } from "../../../router";
import { initialParam, librariesHref } from "../links";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import { tabLabel } from "../nav";
import {
  TYPE_ICON,
  accessSummary,
  capabilityLabels,
  formatCount,
  formatLibrarySize,
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

// One library's Manage page (4.73), under Library › Libraries at
// /control/libraries/<id>. The row used to carry an icon per dialog — layout or
// faces, members, edit, rescan, delete — plus an ⓘ for its details; now the row
// has Manage and a ⋯ menu, and this page lists what can be set for this type of
// library, each opening the dialog that already set it. Like a member's page, it
// is a page of one thing: it drops the tab row and links back to the list.
// LibrariesSection owns the data and the dialogs; this is the page around them.

export type LibraryEditTab = "access" | "upload" | "scanning" | "video" | "phones";

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

  // What this type of library can have set, each row opening its dialog.
  const rows: { key: string; title: string; body: string; action: ReactNode }[] = [
    {
      key: "access",
      title: t("control:libraries.manage.accessTitle"),
      body: t("control:libraries.manage.accessBody", { access: accessSummary(library), owner: ownerLabel }),
      action: <ManageButton onClick={() => onEdit("access")} />
    }
  ];
  // A personal library has no grants to give; a system one is the app's.
  if (!library.personal && !library.role) {
    rows.push({
      key: "members",
      title: t("control:libraries.manage.membersTitle"),
      body: t("control:libraries.manage.membersBody"),
      action: <ManageButton onClick={onMembers} />
    });
  }
  if (library.type === "video") {
    rows.push({
      key: "video",
      title: t("control:libraries.manage.videoTitle"),
      body: t("control:libraries.manage.videoBody"),
      action: <ManageButton onClick={() => onEdit("video")} />
    });
  } else {
    rows.push(
      {
        key: "upload",
        title: t("control:libraries.manage.uploadTitle"),
        body: t("control:libraries.manage.uploadBody", { extensions }),
        action: <ManageButton onClick={() => onEdit("upload")} />
      },
      {
        key: "scanning",
        title: t("control:libraries.manage.scanningTitle"),
        body: gallery
          ? t("control:libraries.manage.scanningBodyGallery", { sources: scanSources })
          : t("control:libraries.manage.scanningBody", { sources: scanSources }),
        action: <ManageButton onClick={() => onEdit("scanning")} />
      }
    );
  }
  if (books) {
    rows.push({
      key: "layout",
      title: t("control:libraries.manage.layoutTitle"),
      body: t("control:libraries.manage.layoutBody"),
      action: <ManageButton onClick={onScanRules} />
    });
  }
  if (gallery && !library.personal) {
    rows.push({
      key: "faces",
      title: t("control:libraries.manage.facesTitle"),
      body: t("control:libraries.manage.facesBody"),
      action: <ManageButton onClick={onFaces} />
    });
  }
  if (phoneLinkable(library)) {
    rows.push({
      key: "phones",
      title: t("control:libraries.manage.phonesTitle"),
      body: t("control:libraries.manage.phonesBody"),
      action: <ManageButton onClick={() => onEdit("phones")} />
    });
  }

  // The shared sets this type is organized with (Library › Organization).
  const organizing: ControlSection[] = books ? ["categories", "tags"] : gallery ? ["tags"] : ["genres"];
  const organizingBody = books
    ? t("control:libraries.manage.organizingBooks")
    : gallery ? t("control:libraries.manage.organizingGallery") : t("control:libraries.manage.organizingVideo");

  const facts = [
    library.fileCount != null ? t("control:libraries.contentsFiles", { count: library.fileCount, formatted: formatCount(library.fileCount) }) : null,
    library.totalSizeBytes != null ? formatLibrarySize(library.totalSizeBytes) : null
  ].filter(Boolean).join(" · ");

  return (
    <div className="library-manage-page">
      <a className="text-button control-page-back" href={listHref} onClick={(event) => followBack(event, listHref)}>
        <ArrowLeft size={15} aria-hidden="true" />
        {tabLabel("libraries")}
      </a>

      <div className="section-head admin-section-head library-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <TypeIcon size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">{t("control:libraries.manage.eyebrow", { type: rowTypeLabel(library) })}</p>
            <h1>{library.name}</h1>
            <p className="section-description library-manage-facts">
              {facts && <span>{facts}</span>}
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

      <section className="library-manage-card">
        <h2>{t("control:libraries.manage.settingsTitle")}</h2>
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
      </section>

      <section className="library-manage-card">
        <h2>{t("control:libraries.manage.organizingTitle")}</h2>
        <p className="muted">{organizingBody}</p>
        <div className="row-actions library-manage-links">
          {organizing.map((section) => {
            const href = controlHref(section);
            return (
              <a key={section} className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
                {tabLabel(section)}
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            );
          })}
        </div>
      </section>

      <section className="library-manage-card">
        <h2>{t("control:libraries.manage.detailsTitle")}</h2>
        <LibraryDetailsGrid library={library} ownerLabel={ownerLabel} scanSources={scanSources} extensions={extensions} />
      </section>

      {/* A system library is made and removed by the app, never here. */}
      {!library.role && (
        <section className="library-manage-card library-manage-danger">
          <h2>{t("control:libraries.deleteTitle")}</h2>
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

function ManageButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation(["control"]);
  return (
    <Button variant="secondary" compact onClick={onClick}>
      <Pencil size={14} aria-hidden="true" />
      {t("control:libraries.manage.edit")}
    </Button>
  );
}

/** What the details dialog showed until 4.73, as a card on the Manage page. */
function LibraryDetailsGrid({
  library,
  ownerLabel,
  scanSources,
  extensions
}: {
  library: ManagedLibrary;
  ownerLabel: string;
  scanSources: string;
  extensions: string;
}) {
  const { t } = useTranslation(["common", "control"]);
  const capabilities = capabilityLabels(library);
  return (
    <div className="library-info-grid">
      <section className="library-info-section">
        <h3>{t("control:libraries.sectionLibrary")}</h3>
        <dl className="library-info-list">
          <LibraryInfoRow label={t("control:libraries.fieldName")}>{library.name}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldType")}>{typeLabel(library.type)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldPath")}>
            <code>{library.sourcePath ?? t("control:libraries.pathHidden")}</code>
          </LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldOwner")}>{ownerLabel}</LibraryInfoRow>
        </dl>
      </section>

      <section className="library-info-section">
        <h3>{t("control:libraries.sectionAccess")}</h3>
        <dl className="library-info-list">
          <LibraryInfoRow label={t("control:libraries.fieldAccess")}>{accessSummary(library)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldMode")}>{modeLabel(library.mode ?? "managed")}</LibraryInfoRow>
          {library.type === "gallery" && (
            <LibraryInfoRow label={t("control:libraries.fieldSystem")}>
              {library.role === "inbox" ? t("control:libraries.systemInbox") : library.role === "app-files" ? t("control:libraries.systemAppFiles") : t("control:libraries.systemNo")}
            </LibraryInfoRow>
          )}
          <LibraryInfoRow label={t("control:libraries.fieldYourRole")}>{roleLabel(library.myRole)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldCapabilities")}>
            {capabilities.length > 0 ? (
              <span className="library-info-chips">
                {capabilities.map((capability) => (
                  <span key={capability} className="library-info-chip">{capability}</span>
                ))}
              </span>
            ) : (
              t("control:libraries.role.none")
            )}
          </LibraryInfoRow>
        </dl>
      </section>

      <section className="library-info-section">
        <h3>{t("control:libraries.sectionContents")}</h3>
        <dl className="library-info-list">
          <LibraryInfoRow label={t("control:libraries.fieldFiles")}>{formatCount(library.fileCount)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldSize")}>{formatLibrarySize(library.totalSizeBytes)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldStatus")}>
            <span className={`status-badge ${library.scanStatus}`}>{scanStatusLabel(library.scanStatus)}</span>
          </LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldLastScanned")}>
            {library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : t("control:libraries.notYet")}
          </LibraryInfoRow>
        </dl>
      </section>

      <section className="library-info-section">
        <h3>{t("control:libraries.sectionScanning")}</h3>
        <dl className="library-info-list">
          <LibraryInfoRow label={t("control:libraries.fieldSources")}>{scanSources}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldExtensions")}>{extensions}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldUploadLimit")}>
            {library.settings?.maxUploadMB != null ? t("control:libraries.uploadLimitValue", { mb: library.settings.maxUploadMB }) : t("control:libraries.uploadLimitDefault")}
          </LibraryInfoRow>
          {library.type === "audiobook" && (
            <LibraryInfoRow label={t("control:libraries.fieldTagEncoding")}>
              {library.settings?.tagEncoding ?? t("control:libraries.tagEncodingDefault")}
            </LibraryInfoRow>
          )}
          <LibraryInfoRow label={t("control:libraries.fieldCreated")}>{formatManagedDate(library.createdAt)}</LibraryInfoRow>
          <LibraryInfoRow label={t("control:libraries.fieldUpdated")}>{formatManagedDate(library.updatedAt)}</LibraryInfoRow>
        </dl>
      </section>
    </div>
  );
}

function LibraryInfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
