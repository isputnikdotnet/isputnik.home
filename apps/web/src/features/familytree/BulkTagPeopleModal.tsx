import { useEffect, useMemo, useState } from "react";
import { Minus, Network, Plus, Tags, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { lifeYears, type FamilyPerson, type FamilyTag } from "./types";

// Assign family tags to many people at once. Tags are the family tree's
// permission boundary (access.ts), so "let my sister edit her branch" means
// putting one tag on every person in that branch — doing it a profile at a time
// is the reason this exists.
//
// Two things make it a bulk surface rather than a repeated single edit:
//
//   * "Add relatives" grows the selection along the tree itself (partners,
//     children, parents, transitively), because a family is a graph, not a
//     surname. Surnames change on marriage; the tree doesn't lie.
//   * Tags are applied additively, per tag, with a three-way control — add to
//     everyone, remove from everyone, or leave each person as they are. A
//     person may sit in several branches, so a bulk edit must never replace
//     someone's whole tag set the way the person form does.
type TagState = "all" | "some" | "none";
type TagChoice = "add" | "remove" | "keep";

function stateOf(count: number, total: number): TagState {
  if (count === 0) return "none";
  return count === total ? "all" : "some";
}

// Clicking cycles through what makes sense from where the tag stands now.
// Mixed tags get a third stop (back to "leave them alone"); uniform ones don't
// need it — their untouched state is already one of the two ends.
function nextChoice(current: TagChoice, state: TagState): TagChoice {
  if (state === "some") return current === "keep" ? "add" : current === "add" ? "remove" : "keep";
  return current === "add" ? "remove" : "add";
}

function choiceFor(state: TagState, override: TagChoice | undefined): TagChoice {
  if (override) return override;
  return state === "all" ? "add" : state === "none" ? "remove" : "keep";
}

export function BulkTagPeopleModal({
  persons,
  onClose,
  onSaved
}: {
  /** The people the change starts on — a page selection, or one family's members. */
  persons: FamilyPerson[];
  onClose: () => void;
  /** Updated persons straight from the server, so the caller's grid re-renders. */
  onSaved: (persons: FamilyPerson[]) => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const [selected, setSelected] = useState<FamilyPerson[]>(persons);
  const [roster, setRoster] = useState<FamilyPerson[]>(persons);
  const [tags, setTags] = useState<FamilyTag[]>([]);
  const [choices, setChoices] = useState<Record<string, TagChoice>>({});
  const [newTag, setNewTag] = useState("");
  const [expanding, setExpanding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ tags: FamilyTag[] }>("/api/family-tree/tags"),
      // The roster resolves the ids "Add relatives" returns into people we can
      // show; the selection itself already arrived as full records.
      api<{ persons: FamilyPerson[] }>("/api/family-tree/persons")
    ])
      .then(([tagPayload, personPayload]) => {
        setTags(tagPayload.tags);
        setRoster(personPayload.persons);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:bulkTags.errors.load")));
  }, [t]);

  // Every tag in play: the ones already on the tree, plus any typed here.
  const rows = useMemo(() => {
    const names = new Set(tags.map((tag) => tag.name));
    for (const person of selected) for (const name of person.tags) names.add(name);
    for (const name of Object.keys(choices)) names.add(name);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const count = selected.filter((person) => person.tags.includes(name)).length;
        const state = stateOf(count, selected.length);
        return { name, count, state, choice: choiceFor(state, choices[name]) };
      });
  }, [tags, selected, choices]);

  const add = rows.filter((row) => row.choice === "add" && row.state !== "all").map((row) => row.name);
  const remove = rows.filter((row) => row.choice === "remove" && row.state !== "none").map((row) => row.name);
  const dirty = add.length > 0 || remove.length > 0;

  const addRelatives = async () => {
    setExpanding(true);
    setError("");
    try {
      const payload = await api<{ personIds: string[] }>("/api/family-tree/persons/relatives", {
        method: "POST",
        body: JSON.stringify({ personIds: selected.map((person) => person.id) })
      });
      const byId = new Map(roster.map((person) => [person.id, person]));
      for (const person of selected) byId.set(person.id, person);
      setSelected(payload.personIds.map((id) => byId.get(id)).filter((p): p is FamilyPerson => p != null));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:bulkTags.errors.relatives"));
    } finally {
      setExpanding(false);
    }
  };

  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = await api<{ persons: FamilyPerson[] }>("/api/family-tree/persons/tags", {
        method: "POST",
        body: JSON.stringify({ personIds: selected.map((person) => person.id), add, remove })
      });
      onSaved(payload.persons);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:bulkTags.errors.apply"));
      setSaving(false);
    }
  };

  const addNewTag = () => {
    const name = newTag.trim();
    if (!name) return;
    setChoices((current) => ({ ...current, [name]: "add" }));
    setNewTag("");
  };

  return (
    <Modal
      variant="panel"
      title={t("family:bulkTags.title", { count: selected.length })}
      icon={<Tags size={20} />}
      className="ft-bulk-tag-modal"
      busy={saving}
      onClose={onClose}
    >
      {/* The shared padded, scrolling panel body — sections dropped straight
          into the panel grid sit flush against its edges and crowd the
          actions row out of its own track. */}
      <div className="modal-tab-content ft-bulk-tag-content">
        {error && <MessageBox tone="error" title={t("family:bulkTags.errorTitle")}>{error}</MessageBox>}

        <section className="ft-bulk-tag-section">
          <header className="ft-bulk-tag-section-head">
            <h3>{t("family:bulkTags.peopleTitle")}</h3>
            <Button variant="secondary" compact disabled={expanding || saving} onClick={() => void addRelatives()}>
              <Network size={16} aria-hidden="true" />
              {expanding ? t("family:bulkTags.addingRelatives") : t("family:bulkTags.addRelatives")}
            </Button>
          </header>
          <p className="ft-modal-hint">{t("family:bulkTags.relativesHint")}</p>
          <div className="ft-bulk-tag-people">
            {selected.map((person) => (
              <span className="ft-bulk-tag-person" key={person.id}>
                <PersonAvatar person={person} size={28} />
                <span className="ft-bulk-tag-person-name">
                  {person.name}
                  {lifeYears(person) && <small>{lifeYears(person)}</small>}
                </span>
                <button
                  type="button"
                  className="ft-bulk-tag-person-drop"
                  title={t("family:bulkTags.dropPerson", { name: person.name })}
                  aria-label={t("family:bulkTags.dropPerson", { name: person.name })}
                  disabled={saving}
                  onClick={() => setSelected((current) => current.filter((p) => p.id !== person.id))}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        </section>

        <section className="ft-bulk-tag-section">
          <h3>{t("family:bulkTags.tagsTitle")}</h3>
          <p className="ft-modal-hint">{t("family:bulkTags.tagsHint")}</p>

          {rows.length === 0 ? (
            <p className="management-empty">{t("family:bulkTags.noTagsYet")}</p>
          ) : (
            <ul className="ft-bulk-tag-list">
              {rows.map((row) => (
                <li key={row.name}>
                  <button
                    type="button"
                    className={`ft-bulk-tag-row is-${row.choice}`}
                    aria-pressed={row.choice === "add"}
                    disabled={saving}
                    onClick={() =>
                      setChoices((current) => ({ ...current, [row.name]: nextChoice(row.choice, row.state) }))
                    }
                  >
                    <span className="ft-bulk-tag-mark" aria-hidden="true">
                      {row.choice === "add" ? <Plus size={14} /> : row.choice === "remove" ? <X size={14} /> : <Minus size={14} />}
                    </span>
                    <span className="ft-bulk-tag-name">{row.name}</span>
                    <small className="ft-bulk-tag-state">
                      {/* A tag nobody has touched reads as a fact, not a pending
                          change — "everyone gets it" on a tag everyone already
                          carries looks like an edit that isn't there. */}
                      {row.choice === "add"
                        ? row.state === "all" ? t("family:bulkTags.stateAll") : t("family:bulkTags.choiceAdd")
                        : row.choice === "remove"
                          ? row.state === "none" ? t("family:bulkTags.stateNone") : t("family:bulkTags.choiceRemove")
                          : t("family:bulkTags.choiceKeep", { count: row.count })}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="ft-bulk-tag-new">
            <input
              type="text"
              value={newTag}
              disabled={saving}
              placeholder={t("family:bulkTags.newTagPlaceholder")}
              aria-label={t("family:bulkTags.newTagLabel")}
              onChange={(event) => setNewTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); addNewTag(); }
              }}
            />
            <Button variant="secondary" disabled={saving || !newTag.trim()} onClick={addNewTag}>
              {t("family:bulkTags.newTagButton")}
            </Button>
          </div>
        </section>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={saving || !dirty || selected.length === 0} onClick={() => void apply()}>
          {saving ? t("family:bulkTags.applying") : t("family:bulkTags.apply")}
        </Button>
      </div>
    </Modal>
  );
}
