import { useState } from "react";
import type { FamilyPerson } from "./types";

export function FamilyPersonMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`ft-person-mark ${className}`.trim()}
      viewBox="0 0 64 64"
      role="presentation"
      focusable="false"
    >
      <path className="ft-person-mark-branch" d="M32 11v9M20 20h24M20 20v7M44 20v7M32 44v8M22 52h20" />
      <circle className="ft-person-mark-node" cx={20} cy={30} r={4.2} />
      <circle className="ft-person-mark-node" cx={44} cy={30} r={4.2} />
      <circle className="ft-person-mark-head" cx={32} cy={26} r={8.4} />
      <path className="ft-person-mark-body" d="M17.5 49.5c1.7-8 7-12.2 14.5-12.2s12.8 4.2 14.5 12.2" />
      <circle className="ft-person-mark-node" cx={22} cy={52} r={3.6} />
      <circle className="ft-person-mark-node" cx={42} cy={52} r={3.6} />
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
