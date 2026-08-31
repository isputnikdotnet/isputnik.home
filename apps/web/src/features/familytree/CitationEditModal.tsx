import { useEffect, useMemo, useState } from "react";
import { BookMarked } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { eventTypeLabel, type FamilyCitation, type FamilyPersonProfile, type FamilySource } from "./types";

const NEW_SOURCE = "__new__";

// What a citation supports, encoded for the <select>. Create-only — an
// existing citation keeps its target (retargeting = delete + re-add).
interface TargetOption {
  value: string;
  label: string;
  body: { personId?: string; eventId?: string; unionId?: string; fact?: string | null };
}

function targetOptions(profile: FamilyPersonProfile, t: TFunction<readonly ["common", "family"], undefined>): TargetOption[] {
  const options: TargetOption[] = [
    { value: "general", label: t("family:citation.targetGeneral", { name: profile.name }), body: { personId: profile.id, fact: null } },
    { value: "name", label: t("family:citation.targetName"), body: { personId: profile.id, fact: "name" } },
    { value: "birth", label: t("family:citation.targetBirth"), body: { personId: profile.id, fact: "birth" } },
    { value: "death", label: t("family:citation.targetDeath"), body: { personId: profile.id, fact: "death" } }
  ];
  for (const union of profile.unions) {
    if (!union.partner) continue;
    options.push({
      value: `marr:${union.id}`,
      label: t("family:citation.targetMarriage", { name: union.partner.name }),
      body: { unionId: union.id, fact: "marriage" }
    });
    if (union.divorcedDate || union.status === "divorced") {
      options.push({
        value: `div:${union.id}`,
        label: t("family:citation.targetDivorce", { name: union.partner.name }),
        body: { unionId: union.id, fact: "divorce" }
      });
    }
  }
  for (const event of profile.events) {
    const typeLabel = eventTypeLabel(event.type);
    const what = event.label || typeLabel;
    options.push({
      value: `event:${event.id}`,
      label: event.date ? t("family:citation.eventWithYear", { what, year: event.date.slice(0, 4) }) : what,
      body: { eventId: event.id }
    });
  }
  return options;
}

// Add a citation (pick or create the source, choose what it supports) or edit
// an existing citation's annotation and its source's details.
export function CitationEditModal({
  profile,
  citation: existing,
  canEditSources = true,
  onClose,
  onSaved
}: {
  profile: FamilyPersonProfile;
  /** null = add a new citation. */
  citation: FamilyCitation | null;
  /** Sources are a shared bibliography — creating/editing them is admin-only.
      Branch editors can still cite the existing ones. */
  canEditSources?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sources, setSources] = useState<FamilySource[]>([]);
  const [sourceId, setSourceId] = useState(existing?.sourceId ?? NEW_SOURCE);
  const [editSource, setEditSource] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [publisher, setPublisher] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [target, setTarget] = useState("general");
  const [detail, setDetail] = useState(existing?.detail ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { t } = useTranslation(["common", "family"]);

  const targets = useMemo(() => targetOptions(profile, t), [profile, t]);

  useEffect(() => {
    api<{ sources: FamilySource[] }>("/api/family-tree/sources")
      .then((payload) => {
        setSources(payload.sources);
        // Adding with existing sources available: default to the first one.
        if (!existing && payload.sources.length > 0) setSourceId(payload.sources[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:citation.errors.loadSources")));
  }, [existing, t]);

  // Editing a source's shared details starts from its current values.
  const beginEditSource = () => {
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return;
    setTitle(source.title);
    setAuthor(source.author ?? "");
    setPublisher(source.publisher ?? "");
    setSourceUrl(source.url ?? "");
    setEditSource(true);
  };

  const showSourceFields = sourceId === NEW_SOURCE || editSource;
  const selectedSource = sources.find((s) => s.id === sourceId);
  // Without source-edit rights and no existing sources there is nothing to cite.
  const noSourceAvailable = !canEditSources && sources.length === 0;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (showSourceFields && !title.trim()) {
      setError(t("family:citation.errors.titleRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const sourceBody = {
        title: title.trim(),
        author: author.trim() || null,
        publisher: publisher.trim() || null,
        url: sourceUrl.trim() || null
      };
      let citedSourceId = sourceId;
      if (sourceId === NEW_SOURCE) {
        const created = await api<{ source: FamilySource }>("/api/family-tree/sources", {
          method: "POST",
          body: JSON.stringify(sourceBody)
        });
        citedSourceId = created.source.id;
      } else if (editSource) {
        await api(`/api/family-tree/sources/${sourceId}`, { method: "PATCH", body: JSON.stringify(sourceBody) });
      }

      const annotation = { detail: detail.trim() || null, url: url.trim() || null, note: note.trim() || null };
      if (existing) {
        await api(`/api/family-tree/citations/${existing.id}`, { method: "PATCH", body: JSON.stringify(annotation) });
      } else {
        const picked = targets.find((opt) => opt.value === target) ?? targets[0];
        await api("/api/family-tree/citations", {
          method: "POST",
          body: JSON.stringify({ sourceId: citedSourceId, ...picked.body, ...annotation })
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:citation.errors.default"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={existing ? t("family:citation.titleEdit") : t("family:citation.titleAdd", { name: profile.name })}
      icon={<BookMarked size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>}
      <div className="ft-field-stack">
        {existing ? (
          <label className="field">
            <span>{t("family:citation.sourceLabel")}</span>
            {editSource
              ? <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required />
              : (
                <span className="ft-citation-source-row">
                  <span className="ft-citation-source-name">{existing.sourceTitle}</span>
                  {canEditSources && (
                    <Button variant="text" compact onClick={beginEditSource} disabled={saving || sources.length === 0}>
                      {t("family:citation.editSourceDetails")}
                    </Button>
                  )}
                </span>
              )}
          </label>
        ) : (
          <label className="field">
            <span>{t("family:citation.sourceLabel")}</span>
            <select
              value={sourceId}
              onChange={(event) => { setSourceId(event.target.value); setEditSource(false); }}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.title}</option>
              ))}
              {canEditSources && <option value={NEW_SOURCE}>{t("family:citation.newSourceOption")}</option>}
            </select>
          </label>
        )}
        {noSourceAvailable && (
          <MessageBox tone="info" title={t("family:citation.noSourcesTitle")}>
            {t("family:citation.noSourcesBody")}
          </MessageBox>
        )}
        {canEditSources && !existing && sourceId !== NEW_SOURCE && selectedSource && (
          <Button variant="text" compact onClick={beginEditSource} disabled={saving || editSource}>
            {t("family:citation.editSourceDetails")}
          </Button>
        )}
        {showSourceFields && (
          <div className="ft-form-grid">
            {sourceId === NEW_SOURCE && (
              <label className="field">
                <span>{t("family:citation.titleField")}</span>
                <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required />
              </label>
            )}
            <label className="field">
              <span>{t("family:citation.authorField")}</span>
              <input type="text" value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("family:citation.publisherField")}</span>
              <input type="text" value={publisher} onChange={(event) => setPublisher(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("family:citation.sourceUrlField")}</span>
              <input type="url" value={sourceUrl} placeholder="https://…" onChange={(event) => setSourceUrl(event.target.value)} />
            </label>
          </div>
        )}
        {!existing && (
          <label className="field">
            <span>{t("family:citation.supportsLabel")}</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {targets.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t("family:citation.detailFieldLabel")}</span>
          <input type="text" value={detail} onChange={(event) => setDetail(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("family:citation.linkFieldLabel")}</span>
          <input type="url" value={url} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label className="field">
          <span>{t("family:common.notes")}</span>
          <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving || noSourceAvailable}>
          {saving ? t("family:common.saving") : existing ? t("family:common.saveChanges") : t("family:citation.submit")}
        </Button>
      </div>
    </Modal>
  );
}
