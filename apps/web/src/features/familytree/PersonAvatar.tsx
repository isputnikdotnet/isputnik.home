import { useState } from "react";
import type { FamilyPerson } from "./types";

// One person: a head and a pair of shoulders, and nothing else.
//
// It used to draw a small family tree behind the figure — a bar with parent
// nodes above, a stem with child nodes below — and at the sizes it is actually
// used the two collided rather than combined. The head landed on the parents'
// bar and merged with their nodes into a row of three circles; the children's
// stem came up through the shoulders; the child nodes sat on the ends of the
// arc. It read as two icons stacked, not one mark.
//
// Neither place it is used wanted the tree anyway. As an avatar fallback it
// stands for one unnamed person. On the empty Family Tree page the surrounding
// card already draws the branches and the four waiting relatives, and the only
// thing on offer there is "Add person" — so the badge says person.
export function FamilyPersonMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`ft-person-mark ${className}`.trim()}
      viewBox="0 0 64 64"
      role="presentation"
      focusable="false"
    >
      <circle className="ft-person-mark-head" cx={32} cy={24} r={9} />
      <path className="ft-person-mark-body" d="M16 50c2-9.5 8-14.5 16-14.5s14 5 16 14.5" />
    </svg>
  );
}

// Round portrait with a graceful fallback: broken/missing images collapse to the
// person's initial (or a family-tree mark when the name is empty).
export function PersonAvatar({
  person,
  size = 44
}: {
  person: Pick<FamilyPerson, "name" | "portraitUrl"> & Partial<Pick<FamilyPerson, "gender">>;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const initial = person.name.trim().charAt(0).toUpperCase();
  const tone = person.gender === "male" || person.gender === "female" || person.gender === "other"
    ? person.gender
    : "unknown";

  return (
    <span className={`ft-avatar is-${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      {person.portraitUrl && !broken ? (
        <img src={person.portraitUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : initial ? (
        <span className="ft-avatar-initial" style={{ fontSize: size * 0.42 }}>{initial}</span>
      ) : (
        <FamilyPersonMark />
      )}
    </span>
  );
}
