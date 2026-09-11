import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListMusic } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import type { SeriesSummary } from "../types";

// Bulk "Add to series": pick an existing series in the current library or create
// a new one on the spot. Selected books are appended after the series' current
// last position (the server handles ordering).
export function AddToSeriesModal({
  libraryId,
  count,
  kind = "audiobook",
  onClose,
  onSubmit
}: {
  libraryId: string;
  count: number;
  kind?: "audiobook" | "ebook";
  onClose: () => void;
  onSubmit: (target: { seriesId: string } | { newName: string }) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [seriesId, setSeriesId] = useState("");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    api<{ series: SeriesSummary[] }>(`/api/library/${kind}-libraries/${libraryId}/series`)
      .then((payload) => {
        setSeries(payload.series);
        if (payload.series.length === 0) setMode("new");
      })
      .catch(() => setSeries([]))
      .finally(() => setLoading(false));
  }, [libraryId, kind]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = mode === "new"
      ? (newName.trim() ? { newName: newName.trim() } : null)
      : (seriesId ? { seriesId } : null);
    if (!target) {
      setError(mode === "new" ? t("book:catalog.enterNewSeriesNameError") : t("book:catalog.chooseSeriesError"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableAddToSeries"));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("book:catalog.addToSeriesModalTitle", { count })}
      style={{ width: "min(100%, 480px)" }}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">{t("book:catalog.addToSeriesIntro")}</p>

        {loading ? (
          <p className="management-empty">{t("book:catalog.loadingSeries")}</p>
        ) : (
          <>
            {series.length > 0 && (
              <SelectField
                className="book-upload-library"
                label={t("book:detail.rows.series")}
                icon={<ListMusic size={17} />}
                value={mode === "existing" ? seriesId : "__new__"}
                onChange={(value: string) => {
                  if (value === "__new__") {
                    setMode("new");
                  } else {
                    setMode("existing");
                    setSeriesId(value);
                  }
                }}
                options={[
                  { value: "", label: t("book:catalog.chooseSeriesPlaceholder") },
                  ...series.map((item) => ({ value: item.id, label: `${item.name} (${item.bookCount})` })),
                  { value: "__new__", label: t("book:catalog.createNewSeriesOption") }
                ]}
              />
            )}

            {mode === "new" && (
              <div className="field" style={{ marginBottom: 12 }}>
                <span>{t("book:catalog.newSeriesNameLabel")}</span>
                <input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={t("book:series.namePlaceholder")}
                />
              </div>
            )}
          </>
        )}

        {error && <MessageBox tone="error" title={t("book:catalog.unableToAddTitle")}>{error}</MessageBox>}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common:common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving || loading}>
            {saving ? t("book:catalog.adding") : t("book:catalog.addToSeriesButton")}
          </Button>
        </div>
    </Modal>
  );
}
