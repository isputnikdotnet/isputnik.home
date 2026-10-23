import { useTranslation } from "react-i18next";
import { Check, Gamepad2, Play, X } from "lucide-react";
import { Button } from "../../shared/Button";
import { formatDate } from "../../shared/dates";
import { gameMatchHref, gamesHref, type GameInvitation, type GameTurn } from "./useGamesSummary";

// The games' cards on For you, beside "Dad wants you to read this": an
// invitation to answer here, and a match where it is your move to open. Both
// are drawn like the other inbox rows; what they link to is the games app, so
// every link is a plain full navigation (docs/games-platform-plan.md).

/** The game's name for a card. An unknown id is shown as is, so a game added
 *  to the games app before this list reads is still named. */
function gameName(game: string, t: (key: "user:games.dots" | "user:games.starbattle" | "user:games.seabattle") => string): string {
  if (game === "dots") return t("user:games.dots");
  if (game === "starbattle") return t("user:games.starbattle");
  // The name Star Battle had for one release; a games server not yet upgraded still sends it.
  if (game === "seabattle") return t("user:games.seabattle");
  return game;
}

export function InvitationRow({
  card,
  busy = false,
  onAnswer
}: {
  card: GameInvitation;
  busy?: boolean;
  onAnswer: (card: GameInvitation, answer: "accept" | "decline") => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const href = gamesHref();
  const name = gameName(card.game, t);
  return (
    <li className="inbox-card is-unseen">
      <a href={href}><span className="inbox-cover inbox-cover-empty" aria-hidden><Gamepad2 size={20} /></span></a>
      <div className="inbox-card-body">
        <p className="inbox-from">{t("user:games.invited", { name: card.from.name })}</p>
        <a className="inbox-title" href={href}>
          <Gamepad2 size={14} aria-hidden="true" /> {name}
        </a>
        <p className="inbox-subtitle">{formatDate(card.createdAt)}</p>
      </div>
      <div className="inbox-actions">
        <Button variant="primary" compact disabled={busy} onClick={() => void onAnswer(card, "accept")} title={t("user:games.acceptTitle", { name })} aria-label={t("user:games.accept")}>
          <Check size={15} aria-hidden />
          <span className="inbox-action-label">{t("user:games.accept")}</span>
        </Button>
        <Button variant="secondary" compact disabled={busy} onClick={() => void onAnswer(card, "decline")} title={t("user:games.declineTitle")} aria-label={t("user:games.decline")}>
          <X size={15} aria-hidden />
          <span className="inbox-action-label">{t("user:games.decline")}</span>
        </Button>
      </div>
    </li>
  );
}

export function YourMoveRow({ card }: { card: GameTurn }) {
  const { t } = useTranslation(["common", "user"]);
  const href = gameMatchHref(card.game, card.id);
  const name = gameName(card.game, t);
  return (
    <li className="inbox-card is-unseen">
      <a href={href}><span className="inbox-cover inbox-cover-empty" aria-hidden><Gamepad2 size={20} /></span></a>
      <div className="inbox-card-body">
        <p className="inbox-from">{t("user:games.yourMove", { name: card.opponent.name })}</p>
        <a className="inbox-title" href={href}>
          <Gamepad2 size={14} aria-hidden="true" /> {name}
        </a>
        <p className="inbox-subtitle">{formatDate(card.updatedAt)}</p>
      </div>
      <div className="inbox-actions">
        <a className="primary-button compact-button" href={href} aria-label={t("user:games.play")} title={t("user:games.playTitle", { name })}>
          <Play size={15} aria-hidden />
          <span className="inbox-action-label">{t("user:games.play")}</span>
        </a>
      </div>
    </li>
  );
}
