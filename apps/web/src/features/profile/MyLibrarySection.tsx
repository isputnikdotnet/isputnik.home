import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus } from "lucide-react";
import { api } from "../../api";
import { galleryLibraryHref, navigate } from "../../router";
import { useSession } from "../../app/SessionContext";
import { Button } from "../../shared/Button";
import { formatDate } from "../../shared/dates";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import { PhonesSection } from "./PhonesSection";

/** Warn this full, before phones are refused at the limit (server: sync/routes.ts NEAR_LIMIT). */
const NEAR_LIMIT = 0.9;

interface MyLibraryView {
  library: { id: string; name: string; adoptedAt: string | null; sizeBytes: number; items: number } | null;
  canTurnOn: boolean;
  unavailable: "off" | "not_allowed" | "no_folder" | null;
  sizeLimitBytes: number | null;
}

// Profile › My library: a private gallery library only this member can open —
// not other members, not admins (docs/photo-sync-plan.md, phase 1). Turn it on,
// see how much it holds against any limit, open it, and back phones up into it
// (PhonesSection, phase 2).
export function MyLibrarySection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const [view, setView] = useState<MyLibraryView | null>(null);
  const [error, setError] = useState("");
  const [turningOn, setTurningOn] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api<MyLibraryView>("/api/profile/personal-library"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.myLibrary.loadFailed"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function turnOn() {
    setTurningOn(true);
    setError("");
    try {
      setView(await api<MyLibraryView>("/api/profile/personal-library", {
        method: "POST",
        body: JSON.stringify({ name: t("profile.myLibrary.defaultName", { name: user.displayName }) })
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("profile.myLibrary.turnOnFailed"));
    } finally {
      setTurningOn(false);
    }
  }

  const library = view?.library ?? null;
  const limit = view?.sizeLimitBytes ?? null;

  return (
    <section className="opds-access" aria-labelledby="my-library-heading">
      <h2 id="my-library-heading">{t("profile.myLibrary.heading")}</h2>
      <p className="opds-intro">{t("profile.myLibrary.intro")}</p>

      {error && <MessageBox tone="error" title={t("profile.myLibrary.errorTitle")}>{error}</MessageBox>}

      {library && (
        <>
          {library.adoptedAt && (
            <MessageBox tone="info" title={t("profile.myLibrary.adoptedTitle")}>
              {t("profile.myLibrary.adoptedBody", { name: library.name, date: formatDate(library.adoptedAt) })}
            </MessageBox>
          )}
          <dl className="my-library-facts">
            <dt>{t("profile.myLibrary.nameLabel")}</dt>
            <dd>{library.name}</dd>
            <dt>{t("profile.myLibrary.sizeLabel")}</dt>
            <dd>
              {limit != null
                ? t("profile.myLibrary.sizeOfLimit", { used: formatBytes(library.sizeBytes), limit: formatBytes(limit) })
                : formatBytes(library.sizeBytes)}
              {" · "}
              {t("profile.myLibrary.items", { count: library.items })}
            </dd>
          </dl>
          {limit != null && library.sizeBytes >= limit && (
            <MessageBox tone="warning" title={t("profile.myLibrary.fullTitle")}>{t("profile.myLibrary.fullBody")}</MessageBox>
          )}
          {/* Before the limit, not at it (phase 5): phones are refused once it is reached. */}
          {limit != null && library.sizeBytes < limit && library.sizeBytes >= limit * NEAR_LIMIT && (
            <MessageBox tone="warning" title={t("profile.myLibrary.nearLimitTitle", { percent: Math.floor((library.sizeBytes / limit) * 100) })}>
              {t("profile.myLibrary.nearLimitBody", { left: formatBytes(limit - library.sizeBytes) })}
            </MessageBox>
          )}
          <p className="opds-intro">{t("profile.myLibrary.notBackup")}</p>
          <div className="opds-actions">
            <Button variant="primary" onClick={() => navigate(galleryLibraryHref(library.id))}>
              <FolderOpen size={16} aria-hidden="true" />
              {t("profile.myLibrary.open")}
            </Button>
          </div>
          <PhonesSection />
        </>
      )}

      {view && !library && view.canTurnOn && (
        <>
          <p className="opds-intro">{t("profile.myLibrary.turnOnIntro")}</p>
          {limit != null && <p className="opds-intro">{t("profile.myLibrary.limitNote", { limit: formatBytes(limit) })}</p>}
          <div className="opds-actions">
            <Button variant="primary" onClick={() => void turnOn()} disabled={turningOn}>
              <Plus size={16} aria-hidden="true" />
              {turningOn ? t("profile.myLibrary.turningOn") : t("profile.myLibrary.turnOn")}
            </Button>
          </div>
        </>
      )}

      {view && !library && !view.canTurnOn && view.unavailable && (
        <MessageBox tone="info" title={t("profile.myLibrary.unavailableTitle")}>
          {t(`profile.myLibrary.unavailable.${view.unavailable}`)}
        </MessageBox>
      )}
    </section>
  );
}
