import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";
import { cx } from "../../../shared/cx";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { DEFAULT_COVERS } from "../covers";

// Bulk "Group as editions": fold the selected books into one work (= editions of
// the same title). The chosen primary supplies the browse card; the rest become
// alternate editions reachable from the detail page. Selection is same-type in
// practice since you pick from one catalog.
export interface EditionCandidate {
  id: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  publisher?: string | null;
  format?: string | null;
}

export function GroupAsEditionsModal({
  books,
  kind,
  onClose,
  onSubmit
}: {
  books: EditionCandidate[];
  kind: "audiobook" | "ebook";
  onClose: () => void;
  onSubmit: (primaryItemId: string) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  // Default the primary to the richest-looking edition: prefer one with a cover and
  // a known author, else the first with a cover, else the first selected.
  const [primaryId, setPrimaryId] = useState(() =>
    books.find((book) => book.coverUrl && book.authors.length > 0)?.id
    ?? books.find((book) => book.coverUrl)?.id
    ?? books[0]?.id
    ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!primaryId) {
      setError(t("book:catalog.choosePrimaryError"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(primaryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableGroupEditions"));
      setSaving(false);
    }
  };

  const metaFor = (book: EditionCandidate) =>
    [book.format ? book.format.toUpperCase() : null, book.publisher].filter(Boolean).join(" · ");

  return (
    <Modal
      title={t(kind === "ebook" ? "book:catalog.groupTitleEbooks" : "book:catalog.groupTitleBooks", { count: books.length })}
      style={{ width: "min(100%, 480px)" }}
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="muted">{t("book:catalog.groupIntro")}</p>
      <div className="editions-pick-list">
        {books.map((book) => {
          const meta = metaFor(book);
          const byline = book.authors.length > 0 ? book.authors.join(", ") : t("book:metadata.unknownAuthor");
          return (
            <label key={book.id} className={cx("editions-pick-row", primaryId === book.id && "selected")}>
              <input
                type="radio"
                name="primary-edition"
                checked={primaryId === book.id}
                onChange={() => setPrimaryId(book.id)}
              />
              <img src={book.coverUrl ?? DEFAULT_COVERS[kind]} alt="" />
              <span className="editions-pick-text">
                <strong>{book.title}</strong>
                <small>{meta ? `${byline} · ${meta}` : byline}</small>
              </span>
              {primaryId === book.id && <span className="editions-pick-flag">{t("book:editions.primary")}</span>}
            </label>
          );
        })}
      </div>
      {error && <MessageBox tone="error" title={t("book:catalog.unableToGroupTitle")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {t("common:common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("book:catalog.grouping") : t("book:catalog.groupEditionsButton", { count: books.length })}
        </Button>
      </div>
    </Modal>
  );
}
