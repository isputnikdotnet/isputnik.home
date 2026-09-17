import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import type { DbInfo, SystemStatus } from "../../types";

// /api/status for the Overview pages that read it — the Dashboard, Activity and
// Library statistics. They were views of one page that fetched it once; as pages
// of their own each fetches it on arrival.
export function useSystemStatus({ withDbInfo = false }: { withDbInfo?: boolean } = {}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setStatus(payload.status);
    if (withDbInfo) {
      // Database details are secondary — load them separately so a db-info
      // failure never hides the rest of the page.
      api<{ db: DbInfo }>("/api/db/info")
        .then((dbPayload) => setDbInfo(dbPayload.db))
        .catch(() => setDbInfo(null));
    }
  }, [withDbInfo]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlDash:dash.loadFailed")));
  }, [load, t]);

  /** For a RefreshButton: clears the error, reloads, and rethrows so the button shows the failure. */
  const refresh = useCallback(async () => {
    setError("");
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlDash:dash.refreshFailed"));
      throw err;
    }
  }, [load, t]);

  return { status, dbInfo, error, refresh };
}
