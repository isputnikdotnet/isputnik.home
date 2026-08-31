import { useState, useEffect } from "react";
import { BookOpen, BookText, Headphones, Image, Images, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import i18n from "../../i18n";

interface SharedLink {
  id: string;
  kind: "item" | "set" | "album" | "story";
  module: string;
  resourceId: string | null;
  title: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

const KIND_ICON = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: Image,
  gallery_set: Images,
  gallery_album: Images,
  story: BookText
} as const;

function iconFor(module: string) {
  return KIND_ICON[module as keyof typeof KIND_ICON] ?? Link2;
}

const DAY = 24 * 60 * 60 * 1000;

// "Expires in 3 days" is the thing you actually want to know when auditing; the
// exact date matters only once it is far enough out to stop being urgent.
function expiryText(link: SharedLink): string {
  const expires = new Date(link.expiresAt);
  if (link.status === "expired") {
    return i18n.t("misc:sharedLinks.expiredOn", { date: expires.toLocaleDateString() });
  }
  const remaining = expires.getTime() - Date.now();
  if (remaining < DAY) return i18n.t("misc:sharedLinks.expiresWithinDay");
  const days = Math.round(remaining / DAY);
  if (days <= 14) return i18n.t("misc:sharedLinks.expiresInDays", { count: days });
  return i18n.t("misc:sharedLinks.expiresOn", { date: expires.toLocaleDateString() });
}

function describe(link: SharedLink): string {
  if (link.kind === "set") return i18n.t("misc:sharedLinks.describeSet", { count: link.itemCount });
  if (link.kind === "album") return i18n.t("misc:sharedLinks.describeAlbum", { count: link.itemCount });
  if (link.kind === "story") return i18n.t("misc:sharedLinks.describeStory");
  return link.module === "ebook"
    ? i18n.t("misc:sharedLinks.describeEbook")
    : link.module === "gallery"
      ? i18n.t("misc:sharedLinks.describeGallery")
      : i18n.t("misc:sharedLinks.describeAudiobook");
}

export function SharedLinksSection() {
  const { t } = useTranslation(["common", "misc"]);
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<SharedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");

  const load = () => {
    api<{ shares: SharedLink[] }>("/api/shares/mine")
      .then((payload) => setLinks(payload.shares))
      .catch((err) => setError(err instanceof Error ? err.message : t("misc:sharedLinks.unableToLoadFallback")));
  };

  useEffect(load, [t]);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setRevokeError("");
    try {
      await api(`/api/shares/${revoking.id}`, { method: "DELETE" });
      setRevoking(null);
      load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : t("misc:sharedLinks.unableToRevoke"));
    } finally {
      setBusy(false);
    }
  };

  const active = links?.filter((link) => link.status === "active") ?? [];
  const expired = links?.filter((link) => link.status === "expired") ?? [];

  const row = (link: SharedLink) => {
    const Icon = iconFor(link.module);
    return (
      <li className={`shared-link-row${link.status === "expired" ? " is-expired" : ""}`} key={link.id}>
        <span className="shared-link-icon" aria-hidden="true"><Icon size={18} /></span>
        <div className="shared-link-main">
          <span className="shared-link-title">{link.title}</span>
          <span className="shared-link-meta">
            {describe(link)}
            {link.label && ` · ${link.label}`}
            {t("misc:sharedLinks.metaShared", { date: new Date(link.createdAt).toLocaleDateString() })}
          </span>
        </div>
        <span className="shared-link-expiry">{expiryText(link)}</span>
        <Button variant="text" onClick={() => { setRevokeError(""); setRevoking(link); }}>
          {t("misc:sharedLinks.revokeButton")}
        </Button>
      </li>
    );
  };

  return (
    <section className="shared-links-section" aria-labelledby="shared-links-heading">
      <h2 id="shared-links-heading">{t("misc:sharedLinks.heading")}</h2>
      <p className="shared-links-intro">
        {t("misc:sharedLinks.intro")}
      </p>

      {error && <MessageBox tone="error" title={t("misc:sharedLinks.unableToLoadFallback")}>{error}</MessageBox>}

      {links && links.length === 0 && (
        <MessageBox tone="info" title={t("misc:sharedLinks.emptyTitle")}>
          {t("misc:sharedLinks.emptyBody")}
        </MessageBox>
      )}

      {active.length > 0 && (
        <>
          <h3 className="shared-links-group">{t("misc:sharedLinks.activeGroup", { count: active.length })}</h3>
          <ul className="shared-link-list">{active.map(row)}</ul>
        </>
      )}

      {expired.length > 0 && (
        <>
          <h3 className="shared-links-group">{t("misc:sharedLinks.expiredGroup", { count: expired.length })}</h3>
          <p className="shared-links-note">
            {t("misc:sharedLinks.expiredNote")}
          </p>
          <ul className="shared-link-list">{expired.map(row)}</ul>
        </>
      )}

      {revoking && (
        <ConfirmDialog
          title={t("misc:sharedLinks.confirmRevokeTitle", { title: revoking.title })}
          confirmLabel={t("misc:sharedLinks.confirmRevokeLabel")}
          busyLabel={t("misc:sharedLinks.confirmRevokeBusy")}
          danger
          busy={busy}
          error={revokeError}
          onConfirm={revoke}
          onCancel={() => setRevoking(null)}
        >
          {revoking.status === "expired"
            ? t("misc:sharedLinks.confirmRevokeBodyExpired")
            : t("misc:sharedLinks.confirmRevokeBodyActive")}
        </ConfirmDialog>
      )}
    </section>
  );
}
