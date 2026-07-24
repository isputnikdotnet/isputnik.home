import { useEffect, useState } from "react";
import { Link2, Link2Off, Search, UserRound } from "lucide-react";
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
  const [people, setPeople] = useState<GalleryPersonRow[]>([]);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ people: GalleryPersonRow[] }>("/api/library/gallery/people")
      .then((payload) => setPeople(payload.people))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load gallery people"));
  }, []);

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
      setError(err instanceof Error ? err.message : "Unable to update the link");
      setBusyId(null);
    }
  };

  const term = search.trim().toLowerCase();
  const shown = term ? people.filter((p) => p.name.toLowerCase().includes(term)) : people;

  return (
    <Modal
      variant="panel"
      title={`Link ${person.name} to a gallery person`}
      icon={<Link2 size={20} />}
      className="ft-picker-modal"
      busy={busyId != null}
      onClose={onClose}
    >
      {error && <MessageBox tone="error" title="Unable to update">{error}</MessageBox>}
      <p className="ft-modal-hint">
        Photos where the linked gallery person is tagged (or recognised) will appear on this profile automatically.
      </p>
      <label className="ft-picker-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search gallery people</span>
        <input
          type="search"
          value={search}
          placeholder="Search gallery people…"
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
                <strong>{row.name || "Unnamed"}</strong>
                <small>{isLinked ? "Linked" : `${row.faceCount} ${row.faceCount === 1 ? "photo" : "photos"}`}</small>
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="management-empty">{people.length === 0 ? "No gallery people yet — tag someone in the gallery first." : "No one matches."}</p>
        )}
      </div>

      <div className="modal-actions">
        {person.galleryPersonId && (
          <Button variant="secondary" danger onClick={() => void setLink(null)} disabled={busyId != null}>
            <Link2Off size={16} aria-hidden="true" />
            {busyId === "unlink" ? "Unlinking…" : "Unlink"}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busyId != null}>Close</Button>
      </div>
    </Modal>
  );
}
