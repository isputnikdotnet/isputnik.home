import { useEffect, useState } from "react";
import { Link2, Link2Off, Search, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { FamilyPerson } from "./types";

interface GalleryPersonRow {
  id: string;
  name: string;
  faceCount: number;
  coverUrl: string | null;
}

// Link a family member to a gallery Person (face cluster) so photos they're
// tagged in surface on the profile automatically.
export function GalleryPersonLinkModal({
  person,
  onClose,
  onUpdated
}: {
  person: FamilyPerson;
  onClose: () => void;
  onUpdated: (person: FamilyPerson) => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [people, setPeople] = useState<GalleryPersonRow[]>([]);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ people: GalleryPersonRow[] }>("/api/library/gallery/people")
      .then((payload) => setPeople(payload.people))
      .catch((err) => setError(err instanceof Error ? err.message : t("family:galleryLink.errors.loadPeople")));
  }, [t]);

  const setLink = async (galleryPersonId: string | null) => {
    setBusyId(galleryPersonId ?? "unlink");
    setError("");
    try {
      const payload = await api<{ person: FamilyPerson }>(`/api/family-tree/persons/${person.id}`, {
        method: "PATCH",
        body: JSON.stringify({ galleryPersonId })
      });
      onUpdated(payload.person);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:galleryLink.errors.updateLink"));
      setBusyId(null);
    }
  };

  const term = search.trim().toLowerCase();
  const shown = term ? people.filter((p) => p.name.toLowerCase().includes(term)) : people;

  return (
    <Modal
      variant="card"
      title={t("family:galleryLink.modalTitle", { name: person.name })}
      icon={<Link2 size={18} />}
      className="ft-modal ft-picker-modal"
      busy={busyId != null}
      onClose={onClose}
    >
      {error && <MessageBox tone="error" title={t("family:galleryLink.errors.updateTitle")}>{error}</MessageBox>}
      <p className="ft-modal-hint">
        {t("family:galleryLink.hint")}
      </p>
      <label className="ft-picker-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">{t("family:galleryLink.searchAria")}</span>
        <input
          type="search"
          value={search}
          placeholder={t("family:galleryLink.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
      </label>

      <div className="ft-picker-list">
        {shown.map((row) => {
          const isLinked = person.galleryPersonId === row.id;
          return (
            <button
              key={row.id}
              type="button"
              className={`ft-picker-row${isLinked ? " is-linked" : ""}`}
              onClick={() => void setLink(row.id)}
              disabled={busyId != null || isLinked}
            >
              <span className="ft-avatar" style={{ width: 36, height: 36 }} aria-hidden="true">
                {row.coverUrl ? <img src={row.coverUrl} alt="" loading="lazy" /> : <UserRound size={20} />}
              </span>
              <span className="ft-picker-row-name">
                <strong>{row.name || t("family:galleryLink.unnamed")}</strong>
                <small>{isLinked ? t("family:galleryLink.linked") : t("family:common.counts.photo", { count: row.faceCount })}</small>
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="management-empty">{people.length === 0 ? t("family:galleryLink.noGalleryPeopleYet") : t("family:common.noOneMatches")}</p>
        )}
      </div>

      <div className="modal-actions">
        {person.galleryPersonId && (
          <Button variant="secondary" danger onClick={() => void setLink(null)} disabled={busyId != null}>
            <Link2Off size={16} aria-hidden="true" />
            {busyId === "unlink" ? t("family:galleryLink.unlinkingButton") : t("family:galleryLink.unlinkButton")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busyId != null}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
