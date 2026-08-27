import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";

// Share a multi-photo selection (gallery "share these") two ways:
// - Guest link: an anonymous, no-account snapshot of the selection.
// - People: grant registered users access in their own account (they see the
//   photos under "Shared with me") — useful for members who can't otherwise see
//   the library. Mirrors ShareModal's two-tab layout.

type Tab = "link" | "people";

interface SetLinkShare {
  id: string;
  label: string | null;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired";
}

interface DirectoryUser {
  id: string;
  displayName: string;
}

interface SetRecipient {
  userId: string;
  displayName: string;
  email: string;
  itemCount: number;
  expiresAt: string | null;
}

const EXPIRY_OPTIONS = [1, 7, 30];

// User-share expiry runs longer than a guest link's — and can be permanent, since
// the access is gated to the recipient's account rather than a public URL.
const USER_EXPIRY_OPTIONS = [0, 7, 30, 365];

export function ShareSetModal({ itemIds, onClose }: { itemIds: string[]; onClose: () => void }) {
  const { t } = useTranslation(["common", "user"]);
  const [tab, setTab] = useState<Tab>("link");
  const [error, setError] = useState("");

  // Link tab
  const [links, setLinks] = useState<SetLinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [skippedNote, setSkippedNote] = useState("");
  const [copied, setCopied] = useState(false);

  // People tab
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [recipients, setRecipients] = useState<SetRecipient[]>([]);
  const [selectedUser, setSelectedUser] = useState("");
  const [userExpiryDays, setUserExpiryDays] = useState(0);
  const [granting, setGranting] = useState(false);
  const [peopleNote, setPeopleNote] = useState("");

  const loadLinks = () =>
    api<{ shares: SetLinkShare[] }>("/api/shares/sets").then((r) => setLinks(r.shares)).catch(() => {});
  const loadRecipients = () =>
    api<{ recipients: SetRecipient[] }>("/api/shares/set/recipients", {
      method: "POST",
      body: JSON.stringify({ itemIds })
    }).then((r) => setRecipients(r.recipients)).catch(() => {});

  useEffect(() => { void loadLinks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "people") return;
    api<{ users: DirectoryUser[] }>("/api/shares/directory").then((r) => setDirectory(r.users)).catch(() => {});
    void loadRecipients();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewUrl(null);
    setSkippedNote("");
    try {
      const { share } = await api<{ share: { url: string; itemCount: number; skipped: number } }>("/api/shares/set", {
        method: "POST",
        body: JSON.stringify({ itemIds, expiresInDays, label: label.trim() || undefined })
      });
      setNewUrl(share.url);
      if (share.skipped > 0) {
        setSkippedNote(t("user:share.skippedNote", { count: share.skipped, shown: share.itemCount }));
      }
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

  const grantUser = async () => {
    if (!selectedUser) return;
    setGranting(true);
    setError("");
    setPeopleNote("");
    try {
      const result = await api<{ granted: number; skipped: number }>("/api/shares/set/user", {
        method: "POST",
        body: JSON.stringify({ itemIds, userId: selectedUser, expiresInDays: userExpiryDays || undefined })
      });
      const parts = [t("user:share.sharedCount", { count: result.granted })];
      if (result.skipped > 0) parts.push(t("user:share.skippedCount", { count: result.skipped }));
      setPeopleNote(`${parts.join(" · ")}.`);
      setSelectedUser("");
      await loadRecipients();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.shareUserFailed"));
    } finally {
      setGranting(false);
    }
  };

  const revokeUser = async (userId: string) => {
    setError("");
    try {
      await api("/api/shares/set/user/revoke", {
        method: "POST",
        body: JSON.stringify({ itemIds, userId })
      });
      setRecipients((prev) => prev.filter((r) => r.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.revokeFailed"));
    }
  };

  const availableUsers = directory.filter((u) => !recipients.some((r) => r.userId === u.id));

  // No-expiry (0) and one-year (365) are their own phrases; everything else is a
  // plain day count.
  const userExpiryLabel = (days: number) =>
    days === 0 ? t("user:share.noExpiry") : days === 365 ? t("user:share.oneYear") : t("user:share.days", { count: days });

  return (
    <Modal
      variant="panel"
      title={t("user:share.titleCount", { count: itemIds.length })}
      icon={<Link2 size={20} />}
      onClose={onClose}
    >
      <div className="modal-tabs">
        <button className={`modal-tab${tab === "link" ? " active" : ""}`} onClick={() => setTab("link")}>
          {t("user:share.guestLink")}
        </button>
        <button className={`modal-tab${tab === "people" ? " active" : ""}`} onClick={() => setTab("people")}>
          {t("user:share.people")}
        </button>
      </div>

      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title={t("user:share.unableToShare")}>{error}</MessageBox>}

        {tab === "link" && (
          <div className="share-link-tab">
            <p className="muted">{t("user:share.setLinkIntro")}</p>

            <div className="share-create-row">
              <label className="field">
                <span>{t("user:share.expiresIn")}</span>
                <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                  {EXPIRY_OPTIONS.map((days) => <option key={days} value={days}>{t("user:share.days", { count: days })}</option>)}
                </select>
              </label>
              <label className="field">
                <span>{t("user:share.labelField")}</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("user:share.setLabelPlaceholder")} maxLength={100} />
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
                {skippedNote && <p className="muted">{skippedNote}</p>}
              </div>
            )}

            <div className="share-list">
              {links.length === 0 ? (
                <p className="muted">{t("user:share.noQuickLinks")}</p>
              ) : (
                links.map((link) => (
                  <div className="share-list-row" key={link.id}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {link.label || t("user:share.quickLink")} · {t("user:count.items", { count: link.itemCount })}
                      </span>
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
            <p className="muted">{t("user:share.setPeopleIntro")}</p>

            <div className="share-create-row">
              <label className="field">
                <span>{t("user:share.userField")}</span>
                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                  <option value="">{t("user:share.choosePerson")}</option>
                  {availableUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </select>
              </label>
              <label className="field">
                <span>{t("user:share.accessFor")}</span>
                <select value={userExpiryDays} onChange={(e) => setUserExpiryDays(Number(e.target.value))}>
                  {USER_EXPIRY_OPTIONS.map((days) => <option key={days} value={days}>{userExpiryLabel(days)}</option>)}
                </select>
              </label>
              <button className="primary-button" onClick={grantUser} disabled={granting || !selectedUser}>
                <UserPlus size={16} /><span>{granting ? t("user:share.sharing") : t("user:share.share")}</span>
              </button>
            </div>

            {peopleNote && <MessageBox tone="success" title={t("user:share.sharedTitle")}>{peopleNote}</MessageBox>}

            <div className="share-list">
              {recipients.length === 0 ? (
                <p className="muted">{t("user:share.notSharedYet")}</p>
              ) : (
                recipients.map((r) => (
                  <div className="share-list-row" key={r.userId}>
                    <div className="share-list-main">
                      <span className="share-list-label">
                        {r.displayName} · {t("user:share.countOfTotal", { count: itemIds.length, shown: r.itemCount })}
                      </span>
                      <span className="muted">
                        {r.expiresAt ? t("user:share.until", { date: new Date(r.expiresAt).toLocaleDateString() }) : t("user:share.noExpiry")}
                      </span>
                    </div>
                    <button className="icon-button" onClick={() => revokeUser(r.userId)} aria-label={t("user:share.revokeShare")}>
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
