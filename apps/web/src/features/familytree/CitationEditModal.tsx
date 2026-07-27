import { useEffect, useMemo, useState } from "react";
import { BookMarked } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { EVENT_TYPE_OPTIONS, type FamilyCitation, type FamilyPersonProfile, type FamilySource } from "./types";

const NEW_SOURCE = "__new__";

// What a citation supports, encoded for the <select>. Create-only — an
// existing citation keeps its target (retargeting = delete + re-add).
interface TargetOption {
  value: string;
  label: string;
  body: { personId?: string; eventId?: string; unionId?: string; fact?: string | null };
}

function targetOptions(profile: FamilyPersonProfile): TargetOption[] {
  const options: TargetOption[] = [
    { value: "general", label: `${profile.name} (general)`, body: { personId: profile.id, fact: null } },
    { value: "name", label: "Name", body: { personId: profile.id, fact: "name" } },
    { value: "birth", label: "Birth", body: { personId: profile.id, fact: "birth" } },
    { value: "death", label: "Death", body: { personId: profile.id, fact: "death" } }
  ];
  for (const union of profile.unions) {
    if (!union.partner) continue;
    options.push({ value: `marr:${union.id}`, label: `Marriage to ${union.partner.name}`, body: { unionId: union.id, fact: "marriage" } });
    if (union.divorcedDate || union.status === "divorced") {
      options.push({ value: `div:${union.id}`, label: `Divorce from ${union.partner.name}`, body: { unionId: union.id, fact: "divorce" } });
    }
  }
  for (const event of profile.events) {
    const typeLabel = EVENT_TYPE_OPTIONS.find((o) => o.value === event.type)?.label ?? event.type;
    const what = event.label || typeLabel;
    options.push({
      value: `event:${event.id}`,
      label: `${what}${event.date ? ` (${event.date.slice(0, 4)})` : ""}`,
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
  onClose,
  onSaved
}: {
  profile: FamilyPersonProfile;
  /** null = add a new citation. */
  citation: FamilyCitation | null;
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

  const targets = useMemo(() => targetOptions(profile), [profile]);

  useEffect(() => {
    api<{ sources: FamilySource[] }>("/api/family-tree/sources")
      .then((payload) => {
        setSources(payload.sources);
        // Adding with existing sources available: default to the first one.
        if (!existing && payload.sources.length > 0) setSourceId(payload.sources[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load sources"));
  }, [existing]);

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

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (showSourceFields && !title.trim()) {
      setError("The source needs a title.");
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
        const picked = targets.find((t) => t.value === target) ?? targets[0];
        await api("/api/family-tree/citations", {
          method: "POST",
          body: JSON.stringify({ sourceId: citedSourceId, ...picked.body, ...annotation })
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the citation");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={existing ? "Edit citation" : `Add source for ${profile.name}`}
      icon={<BookMarked size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      <div className="ft-field-stack">
        {existing ? (
          <label className="field">
            <span>Source</span>
            {editSource
              ? <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required />
              : (
                <span className="ft-citation-source-row">
                  <span className="ft-citation-source-name">{existing.sourceTitle}</span>
                  <Button variant="text" compact onClick={beginEditSource} disabled={saving || sources.length === 0}>
                    Edit source details
                  </Button>
                </span>
              )}
          </label>
        ) : (
          <label className="field">
            <span>Source</span>
            <select
              value={sourceId}
              onChange={(event) => { setSourceId(event.target.value); setEditSource(false); }}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.title}</option>
              ))}
              <option value={NEW_SOURCE}>+ New source…</option>
            </select>
          </label>
        )}
        {!existing && sourceId !== NEW_SOURCE && selectedSource && (
          <Button variant="text" compact onClick={beginEditSource} disabled={saving || editSource}>
            Edit source details
          </Button>
        )}
        {showSourceFields && (
          <div className="ft-form-grid">
            {sourceId === NEW_SOURCE && (
              <label className="field">
                <span>Title</span>
                <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required />
              </label>
            )}
            <label className="field">
              <span>Author</span>
              <input type="text" value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label className="field">
              <span>Publisher</span>
              <input type="text" value={publisher} onChange={(event) => setPublisher(event.target.value)} />
            </label>
            <label className="field">
              <span>Source URL</span>
              <input type="url" value={sourceUrl} placeholder="https://…" onChange={(event) => setSourceUrl(event.target.value)} />
            </label>
          </div>
        )}
        {!existing && (
          <label className="field">
            <span>Supports</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {targets.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Where in the source (page, record #…)</span>
          <input type="text" value={detail} onChange={(event) => setDetail(event.target.value)} />
        </label>
        <label className="field">
          <span>Link to the record</span>
          <input type="url" value={url} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add citation"}
        </Button>
      </div>
    </Modal>
  );
}
