import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/Button";
import { cx } from "../../../shared/cx";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { PeopleCombobox } from "../../../shared/PeopleCombobox";
import { SelectField } from "../../../shared/SelectField";
import type { CategorySummary } from "../types";

// Bulk-edit dialog: overwrite shared metadata across the selected books. Any
// field left blank is skipped (keeps each book's existing value); Tags replace
// the existing tags on every selected book.
export function BulkEditModal({
  count,
  categories,
  peopleSuggestions,
  tagSuggestions,
  showNarrator = true,
  onClose,
  onSubmit
}: {
  count: number;
  categories: CategorySummary[];
  peopleSuggestions: string[];
  tagSuggestions: string[];
  // Audiobooks edit narrators; ebooks have none, so that field is hidden there.
  showNarrator?: boolean;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [narrators, setNarrators] = useState<string[]>([]);
  const [categoryKey, setCategoryKey] = useState("");
  const [language, setLanguage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [tab, setTab] = useState<"details" | "tags">("details");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (authors.length) payload.authors = authors;
    if (narrators.length) payload.narrators = narrators;
    if (categoryKey) payload.categoryKey = categoryKey;
    if (language.trim()) payload.language = language.trim();
    if (tags.length) payload.tags = tags;
    if (description.trim()) payload.description = description.trim();

    if (Object.keys(payload).length === 0) {
      setError(t("book:catalog.bulkNeedField"));
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:catalog.unableUpdateBooks"));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("book:catalog.bulkEditTitle", { count })}
      className="bulk-edit-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
        <p className="muted">{t("book:catalog.bulkEditIntro")}</p>
        <div className="modal-tabs" role="tablist" aria-label={t("book:catalog.bulkEditSectionsAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "details"}
            className={cx("modal-tab", tab === "details" && "active")}
            onClick={() => setTab("details")}
          >
            {t("book:catalog.tabDetails")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tags"}
            className={cx("modal-tab", tab === "tags" && "active")}
            onClick={() => setTab("tags")}
          >
            {t("book:catalog.tabTags")}
          </button>
        </div>
        <div className="modal-tab-content">
          {tab === "details" && (
            <div className="override-grid">
              <div className="field">
                <span>{t("book:catalog.fieldAuthor")}</span>
                <PeopleCombobox value={authors} onChange={setAuthors} suggestions={peopleSuggestions} placeholder={t("book:metadata.addAuthor")} />
              </div>
              {showNarrator && (
                <div className="field">
                  <span>{t("book:catalog.fieldNarrator")}</span>
                  <PeopleCombobox value={narrators} onChange={setNarrators} suggestions={peopleSuggestions} placeholder={t("book:metadata.addNarrator")} />
                </div>
              )}
              <SelectField
                label={t("book:metadata.fieldCategory")}
                value={categoryKey}
                onChange={setCategoryKey}
                options={[
                  { value: "", label: t("book:catalog.keepCurrent") },
                  ...categories.map((category) => ({ value: category.key, label: category.name }))
                ]}
              />
              <Field label={t("book:catalog.fieldLanguageExample")} value={language} onChange={setLanguage} required={false} />
              <label className="field override-desc">
                <span>{t("book:metadata.fieldDescription")}</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
              </label>
            </div>
          )}
          {tab === "tags" && (
            <div className="bulk-tags-tab">
              <div className="field">
                <span>{t("book:metadata.fieldTags")}</span>
                <PeopleCombobox value={tags} onChange={setTags} suggestions={tagSuggestions} placeholder={t("book:metadata.addTag")} />
              </div>
              <p className="muted bulk-tags-note">{t("book:catalog.bulkTagsNote")}</p>
            </div>
          )}
        </div>
        {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common:common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t("book:detail.saving") : t("book:catalog.overwriteButton", { count })}
          </Button>
        </div>
    </Modal>
  );
}
