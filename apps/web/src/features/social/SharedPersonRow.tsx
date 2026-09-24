import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Images, UserRound, X } from "lucide-react";
import { galleryPersonHref } from "../../router";
import { Button } from "../../shared/Button";
import { formatDate } from "../../shared/dates";

// New photos of someone shared with this person (docs/people-sharing-plan.md), as
// a row on For you: "3 new photos of Ivan". Derived from when faces were
// confirmed — nothing is sent. See photos opens that person in the Gallery; Not
// now hides the row until more photos of them are confirmed. Either way the
// photos stay in the Gallery.

export interface SharedPersonCard {
  kind: "person";
  id: string;
  personId: string;
  name: string;
  count: number;
  newestAt: string;
  seen: boolean;
  coverUrl: string | null;
}

export function SharedPersonRow({
  card,
  busy = false,
  onClear
}: {
  card: SharedPersonCard;
  busy?: boolean;
  /** open = See photos (then go there), otherwise Not now. */
  onClear: (card: SharedPersonCard, open: boolean) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user"]);
  const href = galleryPersonHref(card.personId);
  const open = (event: React.MouseEvent) => {
    // A plain click clears the row and then opens; a new-tab click just opens.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void onClear(card, true);
  };
  const cover = card.coverUrl
    ? <img className="inbox-cover" src={card.coverUrl} alt="" />
    : <span className="inbox-cover inbox-cover-empty" aria-hidden><ImageIcon size={20} /></span>;

  return (
    <li className={`inbox-card${card.seen ? "" : " is-unseen"}`}>
      <a href={href} onClick={open}>{cover}</a>
      <div className="inbox-card-body">
        <p className="inbox-from">{t("user:forYou.personShared")}</p>
        <a className="inbox-title" href={href} onClick={open}>
          <UserRound size={14} aria-hidden="true" /> {t("user:forYou.personNew", { count: card.count, name: card.name })}
        </a>
        <p className="inbox-subtitle">{formatDate(card.newestAt)}</p>
      </div>
      <div className="inbox-actions">
        <a className="primary-button compact-button" href={href} onClick={open} aria-label={t("user:forYou.seePhotos")} title={t("user:forYou.seePhotos")}>
          <Images size={15} aria-hidden />
          <span className="inbox-action-label">{t("user:forYou.seePhotos")}</span>
        </a>
        <Button variant="secondary" compact disabled={busy} onClick={() => void onClear(card, false)} title={t("user:forYou.personNotNowTitle")} aria-label={t("user:social.notNow")}>
          <X size={15} aria-hidden />
          <span className="inbox-action-label">{t("user:social.notNow")}</span>
        </Button>
      </div>
    </li>
  );
}
