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
import { useTranslation } from "react-i18next";
import type { KeeperConfidence, MatchConfidence } from "./cleanup-types";

const MATCH_TONE: Record<MatchConfidence, string> = {
  certain: "is-certain",
  likely: "is-likely",
  unsure: "is-unsure"
};

const MATCH_KEY: Record<MatchConfidence, "matchCertain" | "matchLikely" | "matchUnsure"> = {
  certain: "matchCertain",
  likely: "matchLikely",
  unsure: "matchUnsure"
};

// Chosen on something a person did — no badge, because it needs no caveat.
const KEEPER_KEY: Record<KeeperConfidence, "keeperGuess" | "keeperTossup" | null> = {
  evidence: null,
  guess: "keeperGuess",
  tossup: "keeperTossup"
};

export function CertaintyBadge({
  match,
  keeper
}: {
  match: MatchConfidence;
  keeper: KeeperConfidence;
}) {
  const { t } = useTranslation(["common", "controlDash"]);
  const matchKey = MATCH_KEY[match];
  const keeperKey = KEEPER_KEY[keeper];
  const Icon = match === "certain" ? CircleCheck : match === "likely" ? CircleHelp : TriangleAlert;

  return (
    <span className="dup-certainty">
      <span className={`dup-certainty-chip ${MATCH_TONE[match]}`} title={t(`controlDash:dupes.${matchKey}Hint`)}>
        <Icon size={12} aria-hidden="true" />
        <span>{t(`controlDash:dupes.${matchKey}`)}</span>
      </span>
      {/* Only when it needs saying. A keeper chosen on your own tags or folder rules is
          the expected case, and a badge on every card teaches people to ignore badges. */}
      {keeperKey && (
        <span className="dup-certainty-chip is-keeper" title={t(`controlDash:dupes.${keeperKey}Hint`)}>
          <span>{t(`controlDash:dupes.${keeperKey}`)}</span>
        </span>
      )}
    </span>
  );
}
