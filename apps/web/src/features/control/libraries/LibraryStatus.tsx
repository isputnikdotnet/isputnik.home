import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { followRoute } from "../../../router";
import { formatManagedDate } from "../../../shared/utils";
import { tasksHref } from "../links";
import type { ManagedLibrary } from "./managed-library";

// How a library stands, in a word and a line under it — the Status column of
// Library › Libraries and the head of its Manage page (4.73). Most pressing first:
// a video library whose engine isn't answering, a scan running (with the way to
// follow it), the last scan failing, then when it was last checked.
export function LibraryStatus({
  library,
  scanning,
  videoEngineDown
}: {
  library: ManagedLibrary;
  scanning: boolean;
  videoEngineDown: boolean;
}) {
  const { t } = useTranslation(["control"]);

  // Someone else's personal library: an admin sees whose and how big, nothing more.
  if (library.personal && !library.canManageLibrary) {
    return <Status tone="off" label={t("control:libraries.status.private")} note={t("control:libraries.status.privateNote")} />;
  }
  if (library.type === "video" && videoEngineDown) {
    return <Status tone="error" label={t("control:libraries.status.engineDown")} note={t("control:libraries.status.engineDownNote")} />;
  }
  if (scanning) {
    const href = tasksHref({ library: library.id });
    return (
      <Status
        tone="busy"
        label={t("control:libraries.status.scanning")}
        note={<a href={href} onClick={(event) => followRoute(event, href)}>{t("control:libraries.status.follow")}</a>}
      />
    );
  }
  if (library.scanStatus === "error") {
    return <Status tone="error" label={t("control:libraries.status.failed")} note={t("control:libraries.status.failedNote")} />;
  }
  return (
    <Status
      tone="ok"
      label={library.lastScannedAt ? t("control:libraries.status.upToDate") : t("control:libraries.status.notScanned")}
      note={library.lastScannedAt ? t("control:libraries.status.checked", { date: formatManagedDate(library.lastScannedAt) }) : undefined}
    />
  );
}

function Status({ tone, label, note }: { tone: "ok" | "busy" | "error" | "off"; label: string; note?: ReactNode }) {
  return (
    <span className={`library-status is-${tone}`}>
      <span className="library-status-dot" aria-hidden="true" />
      <span className="library-status-text">
        {label}
        {note && <small>{note}</small>}
      </span>
    </span>
  );
}
