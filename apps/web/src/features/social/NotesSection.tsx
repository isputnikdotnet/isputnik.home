import { useEffect, useState, type FormEvent } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";

// What the household says about a thing, under the thing itself.
//
// Called "Notes", never "Comments". On a photograph of a grandparent who has
// died, "0 comments · Reply" reads badly and "Add a note" does not — and the
// word sets the expectation for what belongs here.
//
// Flat by construction: no replies, no reactions, no mentions, no counts. The
// body is rendered as TEXT (a React child, never dangerouslySetInnerHTML), which
// is the whole reason the server can store exactly what was typed.

interface Note {
  id: string;
  body: string;
  authorName: string;
  mine: boolean;
  createdAt: string;
  edited: boolean;
  canDelete: boolean;
}

const MAX = 2000;

function when(iso: string): string {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString();
}

export function NotesSection({
  entityType,
  entityId,
  /** Tighter spacing for the gallery lightbox's info panel. */
  compact = false
}: {
  entityType: string;
  entityId: string;
  compact?: boolean;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    const params = new URLSearchParams({ entityType, entityId });
    api<{ notes: Note[] }>(`/api/social/notes?${params.toString()}`)
      .then((payload) => setNotes(payload.notes))
      // A subject the viewer cannot see 404s; showing nothing is the honest
      // rendering, and the page around it is not this component's to break.
      .catch(() => setNotes([]));
  };

  useEffect(load, [entityType, entityId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ note: Note }>("/api/social/notes", {
        method: "POST",
        body: JSON.stringify({ entityType, entityId, body })
      });
      setNotes((current) => [...(current ?? []), payload.note]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to post this note");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    setError("");
    try {
      await api(`/api/social/notes/${confirmDelete.id}`, { method: "DELETE" });
      setNotes((current) => (current ?? []).filter((note) => note.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this note");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className={`notes-section${compact ? " is-compact" : ""}`} aria-label="Notes">
      <h2 className="notes-heading">
        <MessageSquare size={16} aria-hidden />
        <span>Notes</span>
      </h2>

      {notes && notes.length > 0 && (
        <ul className="notes-list">
          {notes.map((note) => (
            <li className="note" key={note.id}>
              <div className="note-head">
                <strong>{note.mine ? "You" : note.authorName}</strong>
                <span className="note-when">{when(note.createdAt)}</span>
                {note.canDelete && (
                  <Button
                    variant="icon"
                    danger
                    compact
                    className="note-remove"
                    title="Remove note"
                    aria-label={`Remove note by ${note.mine ? "you" : note.authorName}`}
                    onClick={() => setConfirmDelete(note)}
                  >
                    <Trash2 size={14} aria-hidden />
                  </Button>
                )}
              </div>
              {/* Rendered as a text child on purpose — see the file header. */}
              <p className="note-body">{note.body}</p>
            </li>
          ))}
        </ul>
      )}

      {notes && notes.length === 0 && (
        <p className="notes-empty">Nothing here yet. Say something about it.</p>
      )}

      <form className="note-form" onSubmit={submit}>
        <textarea
          className="note-input"
          value={draft}
          maxLength={MAX}
          rows={compact ? 2 : 3}
          placeholder="Add a note…"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="note-form-actions">
          <Button variant="primary" compact type="submit" disabled={busy || draft.trim().length === 0}>
            {busy ? "Posting…" : "Post"}
          </Button>
        </div>
      </form>

      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove this note?"
          confirmLabel="Remove note"
          busyLabel="Removing…"
          busy={deleting}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(null)}
        >
          It stops showing under this. Nothing else about the {entityType === "family_tree_person" ? "person" : "item"} changes.
        </ConfirmDialog>
      )}
    </section>
  );
}
