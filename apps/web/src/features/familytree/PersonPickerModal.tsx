import { useEffect, useMemo, useState } from "react";
import { Search, UserRoundPlus, UsersRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { lifeYears, type FamilyPerson } from "./types";

// Pick an existing family member (or create one inline) — the shared surface
// behind "choose a partner" and "choose a child".
export function PersonPickerModal({
  title,
  excludeIds = [],
  onPick,
  onClose
}: {
  title: string;
  /** Persons that can't be picked (e.g. the person themself, existing relatives). */
  excludeIds?: string[];
  onPick: (person: FamilyPerson) => void;
  onClose: () => void;
}) {
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ persons: FamilyPerson[] }>("/api/family-tree/persons")
      .then((payload) => setPersons(payload.persons))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load people"));
  }, []);

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const term = search.trim().toLowerCase();
  const shown = persons.filter(
    (p) =>
      !excluded.has(p.id) &&
      (!term || p.name.toLowerCase().includes(term) || p.maidenName?.toLowerCase().includes(term))
  );

  const createAndPick = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    try {
      const payload = await api<{ person: FamilyPerson }>("/api/family-tree/persons", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      onPick(payload.person);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create this person");
      setCreating(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={title}
      icon={<UsersRound size={18} />}
      className="ft-modal ft-picker-modal"
      busy={creating}
      onClose={onClose}
    >
      {error && <MessageBox tone="error" title="Unable to load people">{error}</MessageBox>}
      <label className="ft-picker-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search people</span>
        <input
          type="search"
          value={search}
          placeholder="Search people…"
          onChange={(event) => setSearch(event.target.value)}
          autoFocus
        />
      </label>

      <div className="ft-picker-list">
        {shown.map((person) => (
          <button key={person.id} type="button" className="ft-picker-row" onClick={() => onPick(person)} disabled={creating}>
            <PersonAvatar person={person} size={36} />
            <span className="ft-picker-row-name">
              <strong>{person.name}</strong>
              {(person.maidenName || lifeYears(person)) && (
                <small>{[person.maidenName ? `née ${person.maidenName}` : "", lifeYears(person)].filter(Boolean).join(" · ")}</small>
              )}
            </span>
          </button>
        ))}
        {shown.length === 0 && (
          <p className="management-empty">{persons.length === 0 ? "No family members yet." : "No one matches."}</p>
        )}
      </div>

      <div className="ft-picker-create">
        <label className="field">
          <span>Or add someone new</span>
          <div className="field-input-wrap">
            <input
              type="text"
              value={newName}
              placeholder="Full name"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createAndPick(); } }}
            />
          </div>
        </label>
        <Button variant="primary" compact onClick={() => void createAndPick()} disabled={creating || !newName.trim()}>
          <UserRoundPlus size={16} aria-hidden="true" />
          {creating ? "Creating…" : "Create"}
        </Button>
      </div>
    </Modal>
  );
}
