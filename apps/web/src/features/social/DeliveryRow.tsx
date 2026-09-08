import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Inbox, MessageSquareText, X } from "lucide-react";
import { followRoute, galleryInboxHref, galleryReviewHref } from "../../router";
import { Button } from "../../shared/Button";

// One batch that arrived in a Photo Inbox this person looks after, as a row on
// For you (docs/for-you-plan.md). Who sent it when it came through a drop link,
// what is in it, and the one action: Review for someone who may Keep, Add what
// you know for someone who may only write on the photos. Not now hides the
// row until more photos arrive in that delivery; the Inbox itself is untouched.

export interface DeliveryCard {
  kind: "delivery";
  id: string;
  libraryId: string;
  libraryName: string;
  folder: string;
  count: number;
  reviewed: number;
  viaLink: boolean;
  who: string | null;
  newestAt: string;
  seen: boolean;
  coverUrl: string | null;
  canReview: boolean;
}

export function DeliveryRow({
  card,
  busy = false,
  onDismiss
}: {
  card: DeliveryCard;
  busy?: boolean;
  /** "Not now": off the list until the delivery grows. Absent = no such button. */
  onDismiss?: (card: DeliveryCard) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const href = card.canReview ? galleryInboxHref(card.libraryId) : galleryReviewHref(card.libraryId, card.folder);
  const reviewHref = galleryReviewHref(card.libraryId, card.folder);
  const cover = card.coverUrl
    ? <img className="inbox-cover" src={card.coverUrl} alt="" />
    : <span className="inbox-cover inbox-cover-empty" aria-hidden><ImageIcon size={20} /></span>;
  const line = card.viaLink && card.who
    ? t("user:forYou.deliveryVia", { who: card.who, count: card.count })
    : t("user:forYou.deliveryArrived", { count: card.count, name: card.libraryName });

  return (
    <li className={`inbox-card${card.seen ? "" : " is-unseen"}`}>
      <a href={href} onClick={(event) => followRoute(event, href)}>{cover}</a>
      <div className="inbox-card-body">
        <p className="inbox-from">{line}</p>
        <a className="inbox-title" href={href} onClick={(event) => followRoute(event, href)}>
          <Inbox size={14} aria-hidden="true" /> {card.folder || card.libraryName}
        </a>
        <p className="inbox-subtitle">
          {card.reviewed > 0
            ? t("user:forYou.deliveryNoted", { reviewed: card.reviewed, count: card.count })
            : new Date(card.newestAt).toLocaleDateString()}
        </p>
      </div>
      <div className="inbox-actions">
        {card.canReview ? (
          <>
            <a className="primary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
              <Inbox size={16} aria-hidden />
              <span>{t("user:forYou.review")}</span>
            </a>
            <a className="secondary-button compact-button" href={reviewHref} onClick={(event) => followRoute(event, reviewHref)}>
              <MessageSquareText size={16} aria-hidden />
              <span>{t("user:forYou.oneAtATime")}</span>
            </a>
          </>
        ) : (
          <a className="primary-button compact-button" href={reviewHref} onClick={(event) => followRoute(event, reviewHref)}>
            <MessageSquareText size={16} aria-hidden />
            <span>{t("user:social.addWhatYouKnow")}</span>
          </a>
        )}
        {onDismiss && (
          <Button variant="secondary" compact disabled={busy} onClick={() => void onDismiss(card)} title={t("user:forYou.notNowTitle")}>
            <X size={16} aria-hidden />
            <span>{t("user:social.notNow")}</span>
          </Button>
        )}
      </div>
    </li>
  );
}
