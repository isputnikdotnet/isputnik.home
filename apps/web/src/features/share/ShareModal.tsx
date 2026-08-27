import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

type Tab = "link" | "people";

interface LinkShare {
  id: string;
  bookId: string;
  bookTitle: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface UserShare {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  expiresAt: string | null;
  createdAt: string;
}

const EXPIRY_OPTIONS = [1, 7, 30];

export function ShareModal({
  bookId,
  bookTitle,
  kind = "audiobook",
  onClose
}: {
  bookId: string;
  bookTitle: string;
  kind?: "audiobook" | "ebook" | "gallery";
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "user"]);
  // Ebooks are read, audiobooks are listened to, gallery items are viewed — the rest
  // of the share flow is identical across types. Each intro is a fully composed
  // sentence per kind (kept inline at the call site so the literal key type isn't
  // widened to `string` by an intermediate variable), not built from a verb/noun
  // pair, since Russian conjugates.
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");

  // Link tab
  const [links, setLinks] = useState<LinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // People tab — who has access, and taking it away. Granting lives in "Send to".
  const [userShares, setUserShares] = useState<UserShare[]>([]);

  const loadLinks = () =>
    api<{ shares: LinkShare[] }>("/api/shares").then((r) => setLinks(r.shares)).catch(() => {});
  const loadUserShares = () =>
    api<{ shares: UserShare[] }>(`/api/shares/user?bookId=${encodeURIComponent(bookId)}`)
      .then((r) => setUserShares(r.shares)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    void loadUserShares();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Match on id, not title: /api/shares returns every link the user owns, and two
  // items can share a title (same book in two libraries, a box set and its parts),
  // which used to cross-list them — and let you revoke the wrong one.
  const myLinks = links.filter((l) => l.bookId === bookId);

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    try {
      const { share } = await api<{ share: { url: string } }>("/api/shares", {
        method: "POST",
        body: JSON.stringify({ bookId, expiresInDays, label: label.trim() || undefined })
      });
      setNewUrl(share.url);
      setLabel("");
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.createFailed"));
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
      setError(t("user:share.copyFailed"));
    }
  };

  const revokeLink = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      setLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.revokeLinkFailed"));
    }
  };

  const revokeUser = async (id: string) => {
    try {
      await api(`/api/shares/user/${id}`, { method: "DELETE" });
      setUserShares((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.revokeFailed"));
    }
  };

  return (
    <Modal variant="panel" title={t("user:share.title", { title: bookTitle })} onClose={onClose}>
        <div className="modal-tabs">
          <button className={`modal-tab${tab === "link" ? " active" : ""}`} onClick={() => setTab("link")}>
            {t("user:share.guestLink")}
          </button>
          <button className={`modal-tab${tab === "people" ? " active" : ""}`} onClick={() => setTab("people")}>
            {t("user:share.people")}
          </button>
        </div>

        <div className="modal-tab-content">
          {error && <MessageBox tone="error" title={t("user:common.errorTitle")}>{error}</MessageBox>}

          {tab === "link" && (
            <div className="share-link-tab">
              <p className="muted">
                {t(kind === "ebook" ? "user:share.linkIntroEbook" : kind === "gallery" ? "user:share.linkIntroGallery" : "user:share.linkIntroAudiobook")}
              </p>

              <div className="share-create-row">
                <label className="field">
                  <span>{t("user:share.expiresIn")}</span>
                  <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                    {EXPIRY_OPTIONS.map((days) => <option key={days} value={days}>{t("user:share.days", { count: days })}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>{t("user:share.labelField")}</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("user:share.labelPlaceholder")} maxLength={100} />
                </label>
                <button className="primary-button" onClick={createLink} disabled={creating}>
                  <Link2 size={16} /><span>{creating ? t("user:actions.creating") : t("user:share.createLink")}</span>
                </button>
              </div>

              {newUrl && (
                <div className="share-new-url">
                  <p className="muted">{t("user:share.copyNow")}</p>
                  <div className="share-url-row">
                    <input readOnly value={newUrl} onFocus={(e) => e.target.select()} />
                    <button className="secondary-button" onClick={copyUrl}>
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                      <span>{copied ? t("user:share.copied") : t("user:actions.copy")}</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="share-list">
                {myLinks.length === 0 ? (
                  <p className="muted">{t("user:share.noActiveLinks")}</p>
                ) : (
                  myLinks.map((link) => (
                    <div className="share-list-row" key={link.id}>
                      <div className="share-list-main">
                        <span className="share-list-label">{link.label || t("user:share.guestLink")}</span>
                        <span className="muted">
                          {link.status === "expired" ? t("user:share.expired") : t("user:share.expiresOn", { date: new Date(link.expiresAt).toLocaleDateString() })}
                        </span>
                      </div>
                      <button className="icon-button" onClick={() => revokeLink(link.id)} aria-label={t("user:share.revokeLink")}>
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
                <Trans
                  i18nKey={kind === "ebook" ? "share.peopleIntroEbook" : kind === "gallery" ? "share.peopleIntroGallery" : "share.peopleIntroAudiobook"}
                  ns="user"
                  components={{ bold: <strong /> }}
                />
              </p>

              <div className="share-list">
                {userShares.length === 0 ? (
                  <p className="muted">{t("user:share.nobodyAccess")}</p>
                ) : (
                  userShares.map((s) => (
                    <div className="share-list-row" key={s.id}>
                      <div className="share-list-main">
                        <span className="share-list-label">{s.displayName}</span>
                        <span className="muted">
                          {s.expiresAt ? t("user:share.until", { date: new Date(s.expiresAt).toLocaleDateString() }) : t("user:share.noExpiry")}
                        </span>
                      </div>
                      <button className="icon-button" onClick={() => revokeUser(s.id)} aria-label={t("user:share.revokeShare")}>
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
