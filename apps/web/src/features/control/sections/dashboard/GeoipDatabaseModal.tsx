import { useRef, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Database } from "lucide-react";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { formatBytes, formatManagedDate } from "../../../../shared/utils";
import type { GeoipStatus } from "../../types";

// Managing the location database. Three ways in, and they are alternatives rather
// than steps — so they are tabs, not one long page: fetch the free country
// database, hand over a city one, or look at what is already in the folder.

type Tab = "country" | "city" | "files";

const TAB_LABEL_KEYS: Record<Tab, "tabCountry" | "tabCity" | "tabFiles"> = {
  country: "tabCountry",
  city: "tabCity",
  files: "tabFiles"
};

const TAB_ORDER: Tab[] = ["country", "city", "files"];

export function GeoipDatabaseModal({
  geoip,
  onChanged,
  onClose
}: {
  geoip: GeoipStatus;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const [tab, setTab] = useState<Tab>(geoip.available ? "city" : "country");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"country" | "url" | "file" | null>(null);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (
    kind: "country" | "url" | "file",
    call: () => Promise<{ installed?: { name: string; databaseType: string } }>,
    failure: string
  ) => {
    setBusy(kind);
    setError("");
    setInstalled("");
    try {
      const result = await call();
      setInstalled(result.installed ? t("controlDash:geoip.nowUsing", { name: result.installed.name }) : t("controlDash:geoip.installed"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(null);
      if (kind === "file" && fileRef.current) fileRef.current.value = "";
    }
  };

  const fetchCountry = () =>
    run("country", () => api("/api/dashboard/locations/database", { method: "POST" }), t("controlDash:geoip.countryFailed"));

  const fetchUrl = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    return run(
      "url",
      async () => {
        const result = await api<{ installed?: { name: string; databaseType: string } }>(
          "/api/dashboard/locations/database/url",
          { method: "POST", body: JSON.stringify({ url: url.trim() }) }
        );
        setUrl("");
        return result;
      },
      t("controlDash:geoip.urlFailed")
    );
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return run(
      "file",
      () => api("/api/dashboard/locations/database/upload", { method: "POST", body: form }),
      t("controlDash:geoip.fileFailed")
    );
  };

  return (
    <Modal
      variant="panel"
      title={t("controlDash:geoip.title")}
      subtitle={
        geoip.available
          ? `${geoip.databaseType ?? t("controlDash:geoip.subtitleInUse")} · ${geoip.tier === "city" ? t("controlDash:geoip.subtitleTownDetail") : t("controlDash:geoip.subtitleCountryDetail")}`
          : t("controlDash:geoip.subtitleNone")
      }
      icon={<Database size={20} />}
      busy={busy !== null}
      className="geoip-modal"
      onClose={onClose}
    >
      <div className="modal-tabs" role="tablist" aria-label={t("controlDash:geoip.title")}>
        {TAB_ORDER.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`modal-tab${tab === value ? " active" : ""}`}
            onClick={() => setTab(value)}
          >
            {t(`controlDash:geoip.${TAB_LABEL_KEYS[value]}`)}
          </button>
        ))}
      </div>

      <div className="modal-tab-content geoip-modal-content">
        {error && <MessageBox tone="error" title={t("controlDash:geoip.installFailedTitle")}>{error}</MessageBox>}
        {installed && <MessageBox tone="success" title={t("controlDash:geoip.installedTitle")}>{installed}</MessageBox>}

        {tab === "country" && (
          <>
            <p className="muted">{t("controlDash:geoip.countryIntro")}</p>
            <div className="geoip-actions">
              <Button variant="primary" disabled={busy !== null} onClick={fetchCountry}>
                {busy === "country"
                  ? t("controlDash:geoip.downloading")
                  : geoip.countryFilePresent
                    ? t("controlDash:geoip.downloadAgain")
                    : t("controlDash:geoip.download")}
              </Button>
            </div>
          </>
        )}

        {tab === "city" && (
          <>
            <p className="muted">
              <Trans i18nKey="geoip.cityIntro" ns="controlDash" components={{ code: <code /> }} />
            </p>

            <form className="geoip-source" onSubmit={fetchUrl}>
              <label className="field">
                <span>{t("controlDash:geoip.downloadLink")}</span>
                <input
                  type="url"
                  value={url}
                  placeholder="https://download.db-ip.com/free/dbip-city-lite-2026-08.mmdb.gz"
                  disabled={busy !== null}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <Button variant="primary" type="submit" disabled={busy !== null || !url.trim()}>
                {busy === "url" ? t("controlDash:geoip.fetching") : t("controlDash:geoip.fetch")}
              </Button>
            </form>

            <label className="field geoip-file-field">
              <span>{t("controlDash:geoip.orFile")}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".mmdb,.gz"
                disabled={busy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                }}
              />
              {busy === "file" && <small className="muted">{t("controlDash:geoip.uploading")}</small>}
            </label>
          </>
        )}

        {tab === "files" && (
          <>
            <p className="muted">{t("controlDash:geoip.filesIntro")}</p>
            <p className="status-db-path"><code>{geoip.directory}</code></p>

            {geoip.databases.length > 0 ? (
              <ul className="geoip-file-list">
                {geoip.databases.map((entry, index) => (
                  <li key={entry.file}>
                    <code>{entry.name}</code>
                    <small>
                      {entry.databaseType} · {formatBytes(entry.sizeBytes)}
                      {entry.buildDate ? ` · ${t("controlDash:geoip.builtOn", { date: formatManagedDate(entry.buildDate) })}` : ""}
                      {index === 0
                        ? ` · ${t("controlDash:geoip.inUse")}`
                        : entry.tier === geoip.tier
                          ? ` · ${t("controlDash:geoip.ignored")}`
                          : ` · ${t("controlDash:geoip.ignoredLessDetail")}`}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="status-empty">{t("controlDash:geoip.folderEmpty")}</p>
            )}
          </>
        )}
      </div>

      <div className="modal-actions geoip-modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
