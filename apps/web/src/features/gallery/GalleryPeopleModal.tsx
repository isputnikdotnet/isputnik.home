import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { api } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { LightboxPeoplePicker } from "./LightboxPeoplePicker";
import type { GalleryPerson } from "./types";

// Put one person on a whole selection from the multi-select bar — the batch
// just uploaded from a birthday, all of it Grandma. The picker is the lightbox's
// (shared/tags/SuggestBox over the library's people, or a new name), and a pick
// applies at once, as it does there: the question is only "who", and the
// people already on each photo stay. One request per batch of ids, so a new
// name becomes one person rather than one per photo.
export function GalleryPeopleModal({
  itemIds,
  onClose,
  onApplied
}: {
  itemIds: string[];
  onClose: () => void;
  onApplied: (updated: number, forbidden: number, name: string) => void;
}) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ people: GalleryPerson[] }>("/api/library/gallery/people")
      .then((payload) => { if (!cancelled) setPeople(payload.people); })
      .catch(() => { /* the box still takes a new name */ });
    return () => { cancelled = true; };
  }, []);

  const apply = async (choice: { personId: string } | { name: string }): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      const result = await sendInBatches<{ updated: number; forbidden: number }>(itemIds, (ids) =>
        api("/api/library/gallery/assets/bulk-people", {
          method: "POST",
          body: JSON.stringify({ ids, ...choice })
        }));
      const name = "name" in choice ? choice.name : (people.find((person) => person.id === choice.personId)?.name ?? "");
      onApplied(result.updated, result.forbidden, name);
      onClose();
      return true;
    } catch (err) {
      // Batched: a failure part-way through has already changed everything the
      // earlier batches carried, and saying only "unable to tag" would hide it.
      setError(err instanceof PartialBulkError
        ? t("galleryModals:common.partiallyApplied", { count: err.applied, error: err.message })
        : err instanceof Error ? err.message : t("galleryModals:people.unableToUpdate"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("galleryModals:people.title")}
      icon={<Users size={20} />}
      busy={busy}
      className="gallery-bulk-edit-modal"
      onClose={onClose}
    >
      <p className="muted">{t("galleryModals:people.appliesTo", { count: itemIds.length })}</p>

      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <div className="gallery-bulk-edit-field">
        <LightboxPeoplePicker people={people} tagged={[]} busy={busy} onPick={apply} onClose={onClose} />
      </div>
    </Modal>
  );
}
