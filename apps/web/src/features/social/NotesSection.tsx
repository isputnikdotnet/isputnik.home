import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { EmojiPicker } from "./EmojiPicker";

// What the household says about a thing, under the thing itself.
//
// Called "Notes", never "Comments". On a photograph of a grandparent who has
// died, "0 comments · Reply" reads badly and "Add a note" does not — and the
// word sets the expectation for what belongs here.
//
// Flat by construction: no replies, no reactions, no mentions, no counts. The
// body is rendered as TEXT (a React child, never dangerouslySetInnerHTML), which
// is the whole reason the server can store exactly what was typed.
//
// Emoji need nothing from that: they ARE plain text and always travelled fine.
// The picker beside Post is there because they were hard to FIND at a desk, not
// because they were unsupported — and rich text is still deliberately absent,
// since rendering markup is what would end the one-sentence XSS story above.

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
  const { t } = useTranslation(["common", "user"]);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
      setError(err instanceof Error ? err.message : t("user:notes.postFailed"));
    } finally {
      setBusy(false);
    }
  };

  // Insert where the caret is, not at the end: somebody who has written a
  // sentence and gone back to the start of it means the emoji to go there.
  // Focus and caret are restored afterwards so typing simply continues.
  const insertEmoji = (emoji: string) => {
    const field = inputRef.current;
    if (!field) {
      setDraft((current) => current + emoji);
      return;
    }
    const start = field.selectionStart ?? draft.length;
    const end = field.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      const caret = start + emoji.length;
      field.setSelectionRange(caret, caret);
    });
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
      setError(err instanceof Error ? err.message : t("user:notes.removeFailed"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className={`notes-section${compact ? " is-compact" : ""}`} aria-label={t("user:notes.title")}>
      <h2 className="notes-heading">
        <MessageSquare size={16} aria-hidden />
        <span>{t("user:notes.title")}</span>
      </h2>

      {notes && notes.length > 0 && (
        <ul className="notes-list">
          {notes.map((note) => (
            <li className="note" key={note.id}>
              <div className="note-head">
                <strong>{note.mine ? t("user:notes.you") : note.authorName}</strong>
                <span className="note-when">{when(note.createdAt)}</span>
                {note.canDelete && (
                  <Button
                    variant="icon"
                    danger
                    compact
                    className="note-remove"
                    title={t("user:notes.remove")}
                    aria-label={note.mine ? t("user:notes.removeMineAria") : t("user:notes.removeByAria", { name: note.authorName })}
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
        <p className="notes-empty">{t("user:notes.empty")}</p>
      )}

      <form className="note-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="note-input"
          value={draft}
          maxLength={MAX}
          rows={compact ? 2 : 3}
          placeholder={t("user:notes.placeholder")}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="note-form-actions">
          <EmojiPicker onPick={insertEmoji} disabled={busy} />
          <Button variant="primary" compact type="submit" disabled={busy || draft.trim().length === 0}>
            {busy ? t("user:notes.posting") : t("user:notes.post")}
          </Button>
        </div>
      </form>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      {confirmDelete && (
        <ConfirmDialog
          title={t("user:notes.removeTitle")}
          confirmLabel={t("user:notes.remove")}
          busyLabel={t("user:actions.removing")}
          busy={deleting}
          danger
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(null)}
        >
          {entityType === "family_tree_person" ? t("user:notes.removeBodyPerson") : t("user:notes.removeBodyItem")}
        </ConfirmDialog>
      )}
    </section>
  );
}
