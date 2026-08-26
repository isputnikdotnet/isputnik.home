import { Check, Heart, X } from "lucide-react";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { recommendationLine } from "./phrasing";

// One thing a family member sent you, still undecided. Rendered on
// "Shared with me" under "Waiting for you".
//
// Neither decision is urgent: like it, or set it aside. The page
// clears the unseen dot on open, so a card that sits here is not nagging anyone.

export interface InboxCard {
  id: string;
  entityType: string;
  entityId: string;
  message: string | null;
  status: "new" | "saved" | "dismissed";
  createdAt: string;
  fromName: string;
  available: boolean;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  href: string;
  /** Only library items can be liked. An album, a slideshow or
   *  a person is not one, and none of them needs a shortlist. */
  savable: boolean;
}

export function InboxRow({
  card,
  busy,
  onAct
}: {
  card: InboxCard;
  busy: boolean;
  onAct: (card: InboxCard, action: "save" | "dismiss") => Promise<void>;
}) {
  const canLike = card.savable && card.available;

  const cover = card.coverUrl
    ? <img className="inbox-cover" src={card.coverUrl} alt="" />
    : <span className="inbox-cover inbox-cover-empty" aria-hidden />;

  return (
    <li className={`inbox-card${card.available ? "" : " is-unavailable"}`}>
      {card.available && card.href
        ? <a href={card.href} onClick={(event) => followRoute(event, card.href)}>{cover}</a>
        : cover}

      <div className="inbox-card-body">
        {/* What they are actually asking, not just that an event happened. */}
        <p className="inbox-from">{recommendationLine(card.fromName, card.entityType)}</p>
        {card.available && card.href ? (
          <a className="inbox-title" href={card.href} onClick={(event) => followRoute(event, card.href)}>
            {card.title}
          </a>
        ) : (
          <span className="inbox-title">{card.title}</span>
        )}
        {card.subtitle && <p className="inbox-subtitle">{card.subtitle}</p>}
        {card.message && <p className="inbox-message">“{card.message}”</p>}
        {!card.available && <p className="inbox-gone">This isn’t available to you any more.</p>}
      </div>

      {/* The action names what actually happens. A savable thing goes to
          Likes, so the button says so rather than a vague "Save" that
          leaves you wondering where it went. Everything else has nowhere to be
          saved to, and "Not now" reads wrong once you have looked at it — so it
          gets a single Done. */}
      <div className="inbox-actions">
        {canLike ? (
          <>
            <Button variant="primary" compact disabled={busy} onClick={() => void onAct(card, "save")}>
              <Heart size={16} aria-hidden />
              <span>{busy ? "Liking…" : "Like"}</span>
            </Button>
            <Button variant="secondary" compact disabled={busy} onClick={() => void onAct(card, "dismiss")}>
              <X size={16} aria-hidden />
              <span>Not now</span>
            </Button>
          </>
        ) : (
          <Button variant="secondary" compact disabled={busy} onClick={() => void onAct(card, "dismiss")}>
            <Check size={16} aria-hidden />
            <span>Done</span>
          </Button>
        )}
      </div>
    </li>
  );
}
