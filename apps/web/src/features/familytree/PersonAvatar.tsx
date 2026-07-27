import { useState } from "react";
import { UserRound } from "lucide-react";
import type { FamilyPerson } from "./types";

// Round portrait with a graceful fallback: broken/missing images collapse to the
// person's initial (or a silhouette when the name is empty).
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
        <UserRound size={size * 0.55} />
      )}
    </span>
  );
}
