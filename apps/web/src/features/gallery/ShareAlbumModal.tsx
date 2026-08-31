import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Share a whole ALBUM two ways — both LIVE, so they always reflect the album's
// current photos (nothing is snapshotted, no item cap):
// - Guest link: an anonymous, no-account URL.
// - People: grant registered users the album under "Shared with me".
// Mirrors ShareSetModal, but keyed on the album instead of a fixed selection.

type Tab = "link" | "people";

interface AlbumLinkShare {
  id: string;
  albumId: string;
  albumName: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface AlbumRecipient {
  userId: string;
  displayName: string;
  email: string;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [1, 7, 30];

export function ShareAlbumModal({ albumId, albumName, onClose }: { albumId: string; albumName: string; onClose: () => void }) {
  const { t } = useTranslation(["common", "galleryModals"]);
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");

  // Link tab
  const [links, setLinks] = useState<AlbumLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // People tab
  const [recipients, setRecipients] = useState<AlbumRecipient[]>([]);

  const loadLinks = () =>
    api<{ shares: AlbumLinkShare[] }>("/api/shares/albums")
      .then((r) => setLinks(r.shares.filter((s) => s.albumId === albumId)))
      .catch(() => {});
  const loadRecipients = () =>
    api<{ recipients: AlbumRecipient[] }>("/api/shares/album/recipients", {
      method: "POST",
      body: JSON.stringify({ albumId })
    }).then((r) => setRecipients(r.recipients)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    void loadRecipients();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    try {
      const { share } = await api<{ share: { url: string } }>("/api/shares/album", {
        method: "POST",
        body: JSON.stringify({ albumId, expiresInDays, label: label.trim() || undefined })
      });
      setNewUrl(share.url);
      setLabel("");
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:shareAlbum.unableToCreateLink"));
    } finally {
      setCreating(false);
    }
  };

  const copyUrl = async () => {
    if (!newUrl) return;
    try {
      await navigator.clipboard.writeText(newUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("galleryModals:shareAlbum.copyFailed"));
    }
  };

  const revokeLink = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      setLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:shareAlbum.unableToRevokeLink"));
    }
  };

  const revokeUser = async (userId: string) => {
    setError("");
    try {
      await api("/api/shares/album/user/revoke", {
        method: "POST",
        body: JSON.stringify({ albumId, userId })
      });
      setRecipients((prev) => prev.filter((r) => r.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:shareAlbum.unableToRevokeUser"));
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("galleryModals:shareAlbum.title", { name: albumName })}
      icon={<Link2 size={20} />}
      onClose={onClose}
    >
      <div className="modal-tabs">
        <button className={`modal-tab${tab === "link" ? " active" : ""}`} onClick={() => setTab("link")}>
          {t("galleryModals:shareAlbum.tabLink")}
        </button>
        <button className={`modal-tab${tab === "people" ? " active" : ""}`} onClick={() => setTab("people")}>
          {t("galleryModals:shareAlbum.tabPeople")}
        </button>
      </div>

      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title={t("galleryModals:shareAlbum.unableToShareTitle")}>{error}</MessageBox>}

        {tab === "link" && (
          <div className="share-link-tab">
            <p className="muted">
              {t("galleryModals:shareAlbum.linkIntro")}
            </p>

            <div className="share-create-row">
              <label className="field">
                <span>{t("galleryModals:shareAlbum.expiresInLabel")}</span>
                <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                  {EXPIRY_OPTIONS.map((days) => (
                    <option key={days} value={days}>{t("common:dateRange.day", { count: days })}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("galleryModals:shareAlbum.labelFieldLabel")}</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={albumName} maxLength={100} />
              </label>
              <button className="primary-button" onClick={() => void createLink()} disabled={creating}>
                <Link2 size={16} /><span>{creating ? t("galleryModals:shareAlbum.creating") : t("galleryModals:shareAlbum.createLink")}</span>
              </button>
            </div>

            {newUrl && (
              <div className="share-new-url">
                <p className="muted">{t("galleryModals:shareAlbum.copyNowHint")}</p>
                <div className="share-url-row">
                  <input readOnly value={newUrl} onFocus={(e) => e.target.select()} />
                  <button className="secondary-button" onClick={() => void copyUrl()}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    <span>{copied ? t("galleryModals:shareAlbum.copied") : t("galleryModals:shareAlbum.copy")}</span>
                  </button>
                </div>
              </div>
            )}

            <div className="share-list">
              {links.length === 0 ? (
                <p className="muted">{t("galleryModals:shareAlbum.noLinks")}</p>
              ) : (
                links.map((link) => (
                  <div className="share-list-row" key={link.id}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {link.label || t("galleryModals:shareAlbum.defaultLinkLabel")} · {t("galleryModals:common.photoCount", { count: link.itemCount })}
                      </span>
                      <span className="muted">
                        {link.status === "expired"
                          ? t("galleryModals:shareAlbum.expiredLabel")
                          : t("galleryModals:shareAlbum.expiresOn", { date: new Date(link.expiresAt).toLocaleDateString() })}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => void revokeLink(link.id)} aria-label={t("galleryModals:shareAlbum.revokeLinkAria")}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === "people" && (
          <div className="share-people-tab">
            <p className="muted">
              <Trans i18nKey="shareAlbum.peopleIntro" ns="galleryModals" components={{ bold: <strong /> }} />
            </p>

            <div className="share-list">
              {recipients.length === 0 ? (
                <p className="muted">{t("galleryModals:shareAlbum.noRecipients")}</p>
              ) : (
                recipients.map((r) => (
                  <div className="share-list-row" key={r.userId}>
                    <div className="share-list-main">
                      <span className="share-list-label">{r.displayName}</span>
                      <span className="muted">
                        {r.expiresAt
                          ? t("galleryModals:shareAlbum.untilDate", { date: new Date(r.expiresAt).toLocaleDateString() })
                          : t("galleryModals:shareAlbum.noExpiry")}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => void revokeUser(r.userId)} aria-label={t("galleryModals:shareAlbum.removeUserAria", { name: r.displayName })}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
