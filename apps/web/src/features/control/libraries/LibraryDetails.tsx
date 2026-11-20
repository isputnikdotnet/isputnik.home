import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatManagedDate } from "../../../shared/utils";
import {
  accessSummary,
  capabilityLabels,
  formatCount,
  formatLibrarySize,
  modeLabel,
  roleLabel,
  scanStatusLabel,
  typeLabel,
  type ManagedLibrary
} from "./managed-library";
import { LibraryStatus } from "./LibraryStatus";

// A library's settings live in one Edit popup, laid out as the Add library wizard
// (owner, 2026-11-19: back to the list, a right-click or ⋯ › Edit, every setting
// inside the popup). The Manage page that held them since 4.73 is gone; its
// /control/libraries/<id> address opens the list with that library's popup.

/** The popup's steps: the settings a type of library has, then its details. */
export type LibraryEditTab = "access" | "members" | "video" | "upload" | "scanning" | "layout" | "faces" | "phones" | "details";

/** Everything about a library at a glance: the Edit popup's Details step. */
export function LibraryDetailsGrid({
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
          {library.engine?.metadata && (
            <LibraryInfoRow label={t("control:libraries.fieldDetails")}>
              <LibraryStatus library={library} scanning={false} videoEngineDown={false} />
            </LibraryInfoRow>
          )}
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
