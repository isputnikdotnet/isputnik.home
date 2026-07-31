import { useState } from "react";
import { Baby, UserRoundPlus, UsersRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { AddChildModal } from "./AddChildModal";
import { AddParentModal } from "./AddParentModal";
import type { FamilyPerson, FamilyPersonProfile, FamilyTree } from "./types";

// The "+" badge on a chart card lands here: pick parent or child, then hand off
// to the same modals the profile page uses.
//
// Those modals need the full profile (existing parents, unions, children) to
// decide what they're actually doing — filling an empty parent slot vs starting
// a new family, which union a child hangs off. The chart only holds the summary
// person, so the profile is fetched once a kind is chosen rather than up front:
// one request per use of the badge, none for merely rendering the chart.
export function AddRelativeModal({
  person,
  tree,
  onClose,
  onAdded
}: {
  person: FamilyPerson;
  /** Read-only, to work out the union `person` hangs off as a child. */
  tree: FamilyTree;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<"parent" | "child" | null>(null);
  const [profile, setProfile] = useState<FamilyPersonProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const parentUnionId = tree.children.find((link) => link.childId === person.id)?.unionId ?? null;
  const parentUnion = parentUnionId ? tree.unions.find((union) => union.id === parentUnionId) : undefined;
  // A parent union holds one or two people; with both slots filled there is no
  // parent left to add, which is the same rule the profile page's menu applies.
  const bothParentsKnown = Boolean(parentUnion?.person1Id && parentUnion.person2Id);

  const choose = async (next: "parent" | "child") => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ person: FamilyPersonProfile }>(`/api/family-tree/persons/${person.id}`);
      setProfile(payload.person);
      setKind(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this person");
    } finally {
      setLoading(false);
    }
  };

  if (profile && kind === "parent") {
    return <AddParentModal person={profile} parentUnionId={parentUnionId} onClose={onClose} onAdded={onAdded} />;
  }
  if (profile && kind === "child") {
    return <AddChildModal person={profile} onClose={onClose} onAdded={onAdded} />;
  }

  return (
    <Modal
      variant="card"
      title={`Add a relative to ${person.name}`}
      icon={<UserRoundPlus size={18} />}
      className="ft-modal"
      busy={loading}
      onClose={onClose}
    >
      {error && <MessageBox tone="error" title="Unable to continue">{error}</MessageBox>}
      <p className="ft-modal-hint">
        Partners and siblings are added from {person.name}'s profile, where the rest of their family is in view.
      </p>
      <div className="ft-relative-choices">
        <Button variant="secondary" disabled={loading || bothParentsKnown} onClick={() => void choose("parent")}>
          <UsersRound size={16} aria-hidden="true" />
          Parent
        </Button>
        <Button variant="secondary" disabled={loading} onClick={() => void choose("child")}>
          <Baby size={16} aria-hidden="true" />
          Child
        </Button>
      </div>
      {bothParentsKnown && (
        <p className="ft-modal-hint">Both of {person.name}'s parents are already recorded.</p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
      </div>
    </Modal>
  );
}
