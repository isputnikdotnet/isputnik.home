import { useRef, useState, type FormEvent } from "react";
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

const TABS: { value: Tab; label: string }[] = [
  { value: "country", label: "Free database" },
  { value: "city", label: "City database" },
  { value: "files", label: "Files" }
];

export function GeoipDatabaseModal({
  geoip,
  onChanged,
  onClose
}: {
  geoip: GeoipStatus;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
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
      setInstalled(result.installed ? `Now using ${result.installed.name}.` : "Database installed.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(null);
      if (kind === "file" && fileRef.current) fileRef.current.value = "";
    }
  };

  const fetchCountry = () =>
    run("country", () => api("/api/dashboard/locations/database", { method: "POST" }), "The download failed");

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
      "That download failed"
    );
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return run(
      "file",
      () => api("/api/dashboard/locations/database/upload", { method: "POST", body: form }),
      "That file could not be installed"
    );
  };

  return (
    <Modal
      variant="panel"
      title="Location database"
      subtitle={
        geoip.available
          ? `${geoip.databaseType ?? "In use"} · ${geoip.tier === "city" ? "town detail" : "country detail"}`
          : "None yet — nothing can be placed on the map"
      }
      icon={<Database size={20} />}
      busy={busy !== null}
      className="geoip-modal"
      onClose={onClose}
    >
      <div className="modal-tabs" role="tablist" aria-label="Location database">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            className={`modal-tab${tab === entry.value ? " active" : ""}`}
            onClick={() => setTab(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="modal-tab-content geoip-modal-content">
        {error && <MessageBox tone="error" title="Unable to install">{error}</MessageBox>}
        {installed && <MessageBox tone="success" title="Installed">{installed}</MessageBox>}

        {tab === "country" && (
          <>
            <p className="muted">
              DB-IP Country Lite: about 9 MB, free, no account. Says which country a sign-in came from. Fetch it again
              every few months — addresses move between networks.
            </p>
            <div className="geoip-actions">
              <Button variant="primary" disabled={busy !== null} onClick={fetchCountry}>
                {busy === "country" ? "Downloading…" : geoip.countryFilePresent ? "Download again" : "Download"}
              </Button>
            </div>
          </>
        )}

        {tab === "city" && (
          <>
            <p className="muted">
              For town-level detail, download a city database yourself — DB-IP City Lite or GeoLite2-City — then fetch
              it here or upload it. A <code>.mmdb.gz</code> is unpacked for you, and a city database always wins over
              the country one.
            </p>

            <form className="geoip-source" onSubmit={fetchUrl}>
              <label className="field">
                <span>Download link</span>
                <input
                  type="url"
                  value={url}
                  placeholder="https://download.db-ip.com/free/dbip-city-lite-2026-08.mmdb.gz"
                  disabled={busy !== null}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <Button variant="primary" type="submit" disabled={busy !== null || !url.trim()}>
                {busy === "url" ? "Fetching…" : "Fetch"}
              </Button>
            </form>

            <label className="field geoip-file-field">
              <span>Or a file from this computer</span>
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
              {busy === "file" && <small className="muted">Uploading…</small>}
            </label>
          </>
        )}

        {tab === "files" && (
          <>
            <p className="muted">Anything dropped in this folder is picked up on the next lookup — no restart.</p>
            <p className="status-db-path"><code>{geoip.directory}</code></p>

            {geoip.databases.length > 0 ? (
              <ul className="geoip-file-list">
                {geoip.databases.map((entry, index) => (
                  <li key={entry.file}>
                    <code>{entry.name}</code>
                    <small>
                      {entry.databaseType} · {formatBytes(entry.sizeBytes)}
                      {entry.buildDate ? ` · built ${formatManagedDate(entry.buildDate)}` : ""}
                      {index === 0 ? " · in use" : entry.tier === geoip.tier ? " · ignored" : " · ignored, less detail"}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="status-empty">The folder is empty.</p>
            )}
          </>
        )}
      </div>

      <div className="modal-actions geoip-modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>Close</Button>
      </div>
    </Modal>
  );
}
