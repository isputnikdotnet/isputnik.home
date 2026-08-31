import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";

// Guest links for a story. Only links live here: sharing a story WITH a member
// needs nothing — a published story is already on their shelf, and Send to
// puts it in their inbox. A link is for the people who have no account.
//
// Every link is LIVE: it renders the story as it stands, with its photos
// resolved against this author's rights each time it is opened.

interface StoryLinkShare {
  id: string;
  storyId: string;
  storyTitle: string;
  label: string | null;
  expandAlbums: boolean;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

const EXPIRY_OPTIONS = [1, 7, 30];

export function ShareStoryModal({
  storyId,
  storyTitle,
  onClose
}: {
  storyId: string;
  storyTitle: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [links, setLinks] = useState<StoryLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [expandAlbums, setExpandAlbums] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const loadLinks = () =>
    api<{ shares: StoryLinkShare[] }>("/api/shares/stories")
      .then((payload) => setLinks(payload.shares.filter((share) => share.storyId === storyId)))
      .catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    try {
      const { share } = await api<{ share: { url: string } }>("/api/shares/story", {
        method: "POST",
        body: JSON.stringify({
          storyId,
          expiresInDays,
          label: label.trim() || undefined,
          expandAlbums
        })
      });
      setNewUrl(share.url);
      setLabel("");
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:share.unableToCreate"));
    } finally {
      setCreating(false);
    }
  };

  const copyUrl = async () => {
    if (!newUrl) return;
    try {
      await navigator.clipboard.writeText(newUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the URL is on screen to copy by hand */
    }
  };

  const revokeLink = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:share.unableToRevoke"));
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("stories:share.title", { name: storyTitle })}
      icon={<Link2 size={20} />}
      onClose={onClose}
    >
      <div className="modal-tab-content share-link-tab">
        {error && <MessageBox tone="error" title={t("stories:share.unableTitle")}>{error}</MessageBox>}

        <p className="muted">{t("stories:share.intro")}</p>

        <div className="share-create-row">
          <label className="field">
            <span>{t("stories:share.expiresIn")}</span>
            <select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
              {EXPIRY_OPTIONS.map((days) => (
                <option key={days} value={days}>{t("common:dateRange.day", { count: days })}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("stories:share.labelField")}</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={storyTitle}
              maxLength={100}
            />
          </label>
          <Button variant="primary" onClick={() => void createLink()} disabled={creating}>
            <Link2 size={16} aria-hidden="true" />
            <span>{creating ? t("stories:share.creating") : t("stories:share.createLink")}</span>
          </Button>
        </div>

        {/* The one thing a story link has to decide that an album link doesn't:
            how far into an embedded set a guest may go. */}
        <label className="field story-share-expand">
          <input
            type="checkbox"
            checked={expandAlbums}
            onChange={(event) => setExpandAlbums(event.target.checked)}
          />
          <span>
            {t("stories:share.expandAlbums")}
            <small className="muted">{t("stories:share.expandAlbumsHint")}</small>
          </span>
        </label>

        {newUrl && (
          <div className="share-new-url">
            <p className="muted">{t("stories:share.copyNow")}</p>
            <div className="share-url-row">
              <input readOnly value={newUrl} onFocus={(event) => event.target.select()} />
              <Button variant="secondary" onClick={() => void copyUrl()}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span>{copied ? t("stories:share.copied") : t("stories:share.copy")}</span>
              </Button>
            </div>
          </div>
        )}

        <div className="share-list">
          {links.length === 0 ? (
            <p className="muted">{t("stories:share.noLinks")}</p>
          ) : (
            links.map((link) => (
              <div className="share-list-row" key={link.id}>
                <div className="share-list-main">
                  <span className="share-list-label">
                    {link.label || t("stories:share.defaultLabel")}
                    {link.expandAlbums && ` · ${t("stories:share.expandedBadge")}`}
                  </span>
                  <span className="muted">
                    {link.status === "expired"
                      ? t("stories:share.expired")
                      : t("stories:share.expiresOn", { date: new Date(link.expiresAt).toLocaleDateString() })}
                  </span>
                </div>
                <Button
                  variant="icon"
                  danger
                  onClick={() => void revokeLink(link.id)}
                  aria-label={t("stories:share.revokeAria")}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
