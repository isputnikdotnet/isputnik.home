// How sure a result is, said on the card rather than left for someone to infer from
// which heading it happens to be under.
//
// TWO BADGES, NEVER ONE. They answer different questions and a set can be confident
// about one and not the other:
//
//   match   are these the same picture? Identical bytes is certain. A perceptual match
//           is not, and grading it is what stops "we found 52 duplicates" being read as
//           52 facts.
//   keeper  is the right copy being kept? Falls straight out of the ordered ladder:
//           winning on "has tags, albums or people" is evidence a person created;
//           reaching "identical in every way" is a coin toss.
//
// Merging them would lose exactly the case that matters most — a byte-identical set
// where the copies are interchangeable and the choice between them was arbitrary. That
// is completely safe and completely uncertain at the same time.
// A third reading lives OUTSIDE this component: the risk gauge on the card's meta
// line, which deliberately IS a fold of the two chips — "how carefully should I look
// before clicking?", folded on the server (assessResultRisk) so every card folds it
// the same way. It sits with the copy count and size because it is the same kind of
// fact: one glanceable property of the set. The chips stay here with the detail.
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import type { KeeperConfidence, MatchConfidence } from "./cleanup-types";

const MATCH: Record<MatchConfidence, { label: string; title: string; tone: string }> = {
  certain: {
    label: "Identical",
    tone: "is-certain",
    title: "The same file, byte for byte. The copies are interchangeable."
  },
  likely: {
    label: "Looks the same",
    tone: "is-likely",
    title: "Matched on what the picture looks like, not on its bytes. Probably a copy — worth a look."
  },
  unsure: {
    label: "Might not match",
    tone: "is-unsure",
    title: "Same size and dimensions but taken at quite different moments, so these may be two "
      + "different photographs that merely look alike. Open them before deleting anything."
  }
};

const KEEPER: Record<KeeperConfidence, { label: string; title: string } | null> = {
  // Chosen on something a person did — no badge, because it needs no caveat.
  evidence: null,
  guess: {
    label: "Kept on a guess",
    title: "Nothing you did separated these, so the choice came from the files themselves — "
      + "resolution, size, which was added first."
  },
  tossup: {
    label: "Either would do",
    title: "Nothing at all separated the copies, so which one stays was decided by a tiebreak. "
      + "It makes no difference which survives."
  }
};

export function CertaintyBadge({
  match,
  keeper
}: {
  match: MatchConfidence;
  keeper: KeeperConfidence;
}) {
  const matchWord = MATCH[match];
  const keeperWord = KEEPER[keeper];
  const Icon = match === "certain" ? CircleCheck : match === "likely" ? CircleHelp : TriangleAlert;

  return (
    <span className="dup-certainty">
      <span className={`dup-certainty-chip ${matchWord.tone}`} title={matchWord.title}>
        <Icon size={12} aria-hidden="true" />
        <span>{matchWord.label}</span>
      </span>
      {/* Only when it needs saying. A keeper chosen on your own tags or folder rules is
          the expected case, and a badge on every card teaches people to ignore badges. */}
      {keeperWord && (
        <span className="dup-certainty-chip is-keeper" title={keeperWord.title}>
          <span>{keeperWord.label}</span>
        </span>
      )}
    </span>
  );
}
