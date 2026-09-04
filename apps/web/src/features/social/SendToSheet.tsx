import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Copy, Link2, Search, Send, Settings, Tablet, Trash2, Users, X } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { profileHref } from "../../router";

// One dialog for every way of getting a thing to somewhere. Before this there
// were three, in three different menus, all meaning "send": mail it to my
// Kindle, make a guest link, tell a family member. The destination picks the
// mechanism — a person gets a pointer, a Kindle gets a file, a link gets a
// token — and the user never has to know there is one.
//
// The three are TABS, and every one of them finishes here. Share link used to
// close this dialog and open a second one built on the same endpoints, which
// meant two places to look for "who can already see this" and a dead end if you
// changed your mind. That dialog is gone; its link manager and its list of
// people with access are the Share link tab and the foot of the People tab.
//
// Stories and gallery albums kept dialogs of their own for a while longer, on
// the grounds that their links were somehow special. They were not — both are
// LIVE links like every other, and the exception only put the same dead end back
// for two kinds of thing. They are managed here now (see LINK_API); the sheet
// closing to open something else is not a shape this dialog has any more.
//
// Two steps, never more: pick who (or what), then write a line.

export interface SendToSubject {
  entityType: string;
  entityId: string;
}

interface Person {
  id: string;
  displayName: string;
  email: string;
  alreadySent: boolean;
  /** Whether they can already open this under their own access. */
  canOpen: boolean;
}

interface Destinations {
  subject: { title: string; subtitle: string | null; coverUrl: string | null; href: string };
  people: Person[];
  /** Whether the caller is allowed to widen access to the people who cannot. */
  canGrant: boolean;
  ereader: { applicable: boolean; configured: boolean };
  guestLink: boolean;
  /** Whether the sheet manages this subject's guest links in the tab. */
  manageLinks: boolean;
  /** Whether the People tab lists who already has an explicit share. */
  manageUserShares: boolean;
}

interface LinkShare {
  id: string;
  label: string | null;
  expiresAt: string;
  status: "active" | "expired";
  /** Whether a story link resolves albums to their photos. Stories only. */
  expandAlbums?: boolean;
  /** The subject this link points at, under a per-kind key — see LINK_API. */
  [subjectKey: string]: unknown;
}

interface UserShare {
  id: string;
  displayName: string;
  email: string;
  expiresAt: string | null;
}

type Tab = "people" | "link" | "ereader";

/** Above this many people the list gets a search box; below it, everyone fits. */
const SEARCH_THRESHOLD = 5;
const EXPIRY_OPTIONS = [1, 7, 30];

// Where a subject's guest links are listed and minted. Every kind revokes on the
// same path, so only these two ever differ, and the key names the field a listed
// link carries its subject in. Anything not named here uses the library-item
// endpoints — books, ebooks and single photos, which is most things.
//
// This table is what lets the Share link tab serve every kind itself. Stories and
// albums used to hand off to dialogs of their own, justified by albums "keeping a
// snapshot of their membership" — which ShareAlbumModal flatly denied: album and
// story links are both LIVE and reflect current contents. The one share that IS a
// snapshot is an ad-hoc photo selection, and it never came through here anyway —
// a selection has no single subject to send.
const LINK_API: Record<string, { list: string; create: string; key: string }> = {
  story: { list: "/api/shares/stories", create: "/api/shares/story", key: "storyId" },
  gallery_album: { list: "/api/shares/albums", create: "/api/shares/album", key: "albumId" }
};
const ITEM_LINK_API = { list: "/api/shares", create: "/api/shares", key: "bookId" };

export function SendToSheet({
  subject,
  onClose,
  onSendToEreader
}: {
  subject: SendToSubject;
  onClose: () => void;
  /** Mails the file to the caller's own e-reader. Omit to hide the tab. */
  onSendToEreader?: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "user", "stories"]);
  const [destinations, setDestinations] = useState<Destinations | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("people");
  // Who is ticked. Ids rather than rows, so a reload of the list can't strand a
  // selection against a stale copy of the person.
  const [picked, setPicked] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ sent: string[]; skipped: string[] } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Share link tab.
  const [links, setLinks] = useState<LinkShare[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  // The link just created, kept whole rather than as a bare URL: revoking it
  // has to take its address off the screen too, or the one row that can show an
  // address goes on showing a dead one.
  const [newLink, setNewLink] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Stories only: whether the link resolves an album block to its photos.
  const [expandAlbums, setExpandAlbums] = useState(false);

  // People tab, lower half: who already has an explicit share.
  const [userShares, setUserShares] = useState<UserShare[]>([]);

  useEffect(() => {
    const params = new URLSearchParams({ entityType: subject.entityType, entityId: subject.entityId });
    api<Destinations>(`/api/social/destinations?${params.toString()}`)
      .then(setDestinations)
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("user:sendTo.loadFailed")));
  }, [subject.entityType, subject.entityId]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const linkApi = LINK_API[subject.entityType] ?? ITEM_LINK_API;
  const isStory = subject.entityType === "story";
  const manageLinks = Boolean(destinations?.manageLinks);
  const manageUserShares = Boolean(destinations?.manageUserShares);

  const loadLinks = () =>
    api<{ shares: LinkShare[] }>(linkApi.list)
      // Matched on id, not title: these endpoints return every link the user
      // owns, and two subjects can share a title (the same book in two
      // libraries, a box set and its parts), which used to cross-list them —
      // and let you revoke the wrong one.
      .then((r) => setLinks(r.shares.filter((share) => share[linkApi.key] === subject.entityId)))
      .catch(() => {});

  // "Who already has this" reads and revokes on its own paths per kind, and an
  // album's recipients come back keyed on userId rather than a share id — so they
  // are normalised to UserShare here and revoked by whichever call that kind
  // takes. Same list, same row, same button, wherever you opened it from.
  const loadUserShares = () => {
    const request = subject.entityType === "gallery_album"
      ? api<{ recipients: (UserShare & { userId: string })[] }>("/api/shares/album/recipients", {
          method: "POST",
          body: JSON.stringify({ albumId: subject.entityId })
        }).then((r) => r.recipients.map((person) => ({ ...person, id: person.userId })))
      : api<{ shares: UserShare[] }>(`/api/shares/user?bookId=${encodeURIComponent(subject.entityId)}`)
          .then((r) => r.shares);
    return request.then(setUserShares).catch(() => {});
  };

  // Fetched separately: a story has links but nobody to list, so asking for its
  // recipients would be a request that can only ever come back empty.
  useEffect(() => {
    if (manageLinks) void loadLinks();
    if (manageUserShares) void loadUserShares();
  }, [manageLinks, manageUserShares, subject.entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = destinations?.people ?? [];
  const pickedPeople = useMemo(
    () => people.filter((person) => picked.includes(person.id)),
    [people, picked]
  );
  // True when ANY of the chosen cannot open this yet — the send then has to ask
  // for the grant, and the compose step has to say so in words first.
  const needsGrant = pickedPeople.some((person) => !person.canOpen);

  const toggle = (person: Person) => {
    setPicked((current) =>
      current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id]
    );
  };

  const send = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ sent: string[]; skipped: string[] }>("/api/social/recommendations", {
        method: "POST",
        body: JSON.stringify({
          entityType: subject.entityType,
          entityId: subject.entityId,
          toUserIds: picked,
          message: message.trim() || null,
          // Only ever true after the compose step has said so in words.
          grantAccess: needsGrant
        })
      });
      setSent(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:sendTo.sendFailed"));
    } finally {
      setBusy(false);
    }
  };

  const sendToEreader = async () => {
    if (!onSendToEreader) return;
    setBusy(true);
    setError("");
    try {
      await onSendToEreader();
      setSent({ sent: [t("user:sendTo.yourEreader")], skipped: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:sendTo.ereaderFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createLink = async () => {
    setCreating(true);
    setError("");
    setNewLink(null);
    try {
      const { share } = await api<{ share: { id: string; url: string } }>(linkApi.create, {
        method: "POST",
        body: JSON.stringify({
          [linkApi.key]: subject.entityId,
          expiresInDays,
          label: label.trim() || undefined,
          // Only a story has anything to say here; the others ignore it.
          ...(isStory ? { expandAlbums } : {})
        })
      });
      setNewLink({ id: share.id, url: share.url });
      setLabel("");
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const copyUrl = async () => {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("user:share.copyFailed"));
    }
  };

  const revokeLink = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      setLinks((prev) => prev.filter((link) => link.id !== id));
      setNewLink((current) => (current?.id === id ? null : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.revokeLinkFailed"));
    }
  };

  const revokeUser = async (id: string) => {
    try {
      if (subject.entityType === "gallery_album") {
        await api("/api/shares/album/user/revoke", {
          method: "POST",
          body: JSON.stringify({ albumId: subject.entityId, userId: id })
        });
      } else {
        await api(`/api/shares/user/${id}`, { method: "DELETE" });
      }
      setUserShares((prev) => prev.filter((share) => share.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("user:share.revokeFailed"));
    }
  };

  // Sent. One line, one button — there is nothing else to decide here. The
  // skipped half is named rather than swallowed: a send to four people that
  // reached three is not the same event as one that reached four.
  if (sent) {
    return (
      <Modal title={t("user:sendTo.sentTitle")} onClose={onClose}>
        <p className="send-to-done">
          <Trans
            i18nKey="sendTo.onItsWay"
            ns="user"
            values={{ name: listNames(sent.sent) }}
            components={{ bold: <strong /> }}
          />
        </p>
        {sent.skipped.length > 0 && (
          <MessageBox tone="warning" title={t("user:sendTo.someSkippedTitle")}>
            {t("user:sendTo.someSkipped", { names: listNames(sent.skipped) })}
          </MessageBox>
        )}
        <div className="modal-actions">
          <Button variant="primary" onClick={onClose}>{t("common:common.done")}</Button>
        </div>
      </Modal>
    );
  }

  // Step two: writing the line. Optional — Send works with an empty box.
  if (composing) {
    return (
      <Modal
        title={pickedPeople.length === 1
          ? t("user:sendTo.sendToName", { name: pickedPeople[0].displayName })
          : t("user:sendTo.sendToCount", { count: pickedPeople.length })}
        busy={busy}
        onClose={onClose}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        {destinations && <SubjectCard subject={destinations.subject} />}
        {pickedPeople.length > 1 && (
          <p className="send-to-recipients">{pickedPeople.map((person) => person.displayName).join(", ")}</p>
        )}
        <label className="send-to-field">
          <span>{t("user:sendTo.sayField")}</span>
          <input
            type="text"
            value={message}
            maxLength={280}
            autoFocus
            placeholder={t("user:sendTo.sayPlaceholder")}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <p className="send-to-note">
          {needsGrant
            ? t("user:sendTo.grantNoteMany", { count: pickedPeople.filter((p) => !p.canOpen).length })
            : t("user:sendTo.linkNoteMany", { count: pickedPeople.length })}
        </p>
        {error && <MessageBox tone="error" title={t("user:sendTo.sendFailed")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setComposing(false)} disabled={busy}>{t("user:sendTo.back")}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("user:actions.sending") : needsGrant ? t("user:sendTo.giveAccessSend") : t("user:actions.send")}
          </Button>
        </div>
      </Modal>
    );
  }

  // Step one: the tabs.
  const canOpen = people.filter((person) => person.canOpen);
  const needsAccess = people.filter((person) => !person.canOpen);
  const showEreader = Boolean(destinations?.ereader.applicable && onSendToEreader);
  const showLink = manageLinks;
  // With nothing to choose between, a row of one tile is decoration.
  const showRoutes = showEreader || showLink;
  const searchable = people.length > SEARCH_THRESHOLD;
  const matches = (person: Person) => {
    const needle = term.trim().toLowerCase();
    if (!needle) return true;
    return person.displayName.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle);
  };
  const linkIntro = subject.entityType === "ebook"
    ? t("user:share.linkIntroEbook")
    : subject.entityType === "audiobook"
      ? t("user:share.linkIntroAudiobook")
      : t("user:share.linkIntroGallery");

  return (
    <Modal
      title={destinations ? t("user:share.title", { title: destinations.subject.title }) : t("user:sendTo.title")}
      className="send-to-modal"
      busy={busy}
      onClose={onClose}
    >
      {loadError && <MessageBox tone="error" title={t("user:common.unableToLoad")}>{loadError}</MessageBox>}
      {destinations && (
        <>
          {showRoutes && (
            <div className="send-to-routes" role="tablist">
              <RouteTile
                id="people"
                active={tab}
                onPick={setTab}
                tone="people"
                icon={<Users size={28} />}
                label={t("user:sendTo.routePeople")}
                hint={t("user:sendTo.routePeopleHint")}
              />
              {showLink && (
                <RouteTile
                  id="link"
                  active={tab}
                  onPick={setTab}
                  tone="link"
                  icon={<Link2 size={28} />}
                  label={t("user:sendTo.routeLink")}
                  hint={t("user:sendTo.routeLinkHint")}
                />
              )}
              {showEreader && (
                <RouteTile
                  id="ereader"
                  active={tab}
                  onPick={setTab}
                  tone="ereader"
                  icon={<Tablet size={28} />}
                  label={t("user:sendTo.routeEreader")}
                  hint={t("user:sendTo.routeEreaderHint")}
                />
              )}
            </div>
          )}

          {tab === "people" && (
            <div className="send-to-quick">
              <div className="send-to-quick-head">
                <h3>{t("user:sendTo.quickSendTo")}</h3>
                {searchable && (
                  searchOpen ? (
                    <button
                      type="button"
                      className="send-to-search-toggle"
                      onClick={() => { setSearchOpen(false); setTerm(""); }}
                    >
                      <span>{t("common:common.close")}</span>
                      <X size={16} aria-hidden="true" />
                    </button>
                  ) : (
                    <button type="button" className="send-to-search-toggle" onClick={() => setSearchOpen(true)}>
                      <span>{t("user:sendTo.search")}</span>
                      <Search size={16} aria-hidden="true" />
                    </button>
                  )
                )}
              </div>

              {searchable && searchOpen && (
                <input
                  ref={searchRef}
                  type="search"
                  className="send-to-search"
                  value={term}
                  placeholder={t("user:sendTo.searchPlaceholder")}
                  aria-label={t("user:sendTo.searchPlaceholder")}
                  onChange={(event) => setTerm(event.target.value)}
                />
              )}

              {people.length === 0 ? (
                <p className="send-to-empty">{t("user:sendTo.nobody")}</p>
              ) : (
                <>
                  <PersonGrid people={canOpen.filter(matches)} picked={picked} onToggle={toggle} />

                  {/* The half that used to send you to a separate Share dialog.
                      Listed here, under a label that says why, so the answer to
                      "why isn't Mom in the list?" is on screen instead of in
                      another menu. */}
                  {needsAccess.filter(matches).length > 0 && (
                    <>
                      <p className="send-to-group-label">
                        {destinations.canGrant ? t("user:sendTo.noAccessYet") : t("user:sendTo.cantOpen")}
                      </p>
                      <PersonGrid
                        people={needsAccess.filter(matches)}
                        picked={picked}
                        onToggle={destinations.canGrant ? toggle : undefined}
                      />
                    </>
                  )}

                  {term.trim() && canOpen.filter(matches).length + needsAccess.filter(matches).length === 0 && (
                    <p className="send-to-empty">{t("user:sendTo.noMatches")}</p>
                  )}
                </>
              )}

              {/* Taking access away — the other half of the dialog this replaced.
                  It belongs beside the list that gives access, not in a second
                  dialog reached from a different menu. */}
              {manageUserShares && userShares.length > 0 && (
                <>
                  <p className="send-to-group-label">{t("user:sendTo.hasAccess")}</p>
                  <ul className="send-to-rows">
                    {userShares.map((share) => (
                      <li key={share.id}>
                        <span className="send-to-row-main">
                          <strong>{share.displayName}</strong>
                          <span>
                            {share.expiresAt
                              ? t("user:share.until", { date: new Date(share.expiresAt).toLocaleDateString() })
                              : t("user:share.noExpiry")}
                          </span>
                        </span>
                        <Button
                          variant="text"
                          danger
                          compact
                          onClick={() => void revokeUser(share.id)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          <span>{t("user:share.revokeShare")}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === "link" && (
              <div className="send-to-panel">
                <p className="send-to-panel-intro">{linkIntro}</p>

                <div className="send-to-link-create">
                  <label className="send-to-field">
                    <span>{t("user:share.expiresIn")}</span>
                    <select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
                      {EXPIRY_OPTIONS.map((days) => (
                        <option key={days} value={days}>{t("user:share.days", { count: days })}</option>
                      ))}
                    </select>
                  </label>
                  <label className="send-to-field">
                    <span>{t("user:share.labelField")}</span>
                    <input
                      value={label}
                      maxLength={100}
                      placeholder={t("user:share.labelPlaceholder")}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                  </label>
                  {isStory && (
                    <label className="send-to-check">
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
                  )}
                  <Button variant="primary" onClick={() => void createLink()} disabled={creating}>
                    <Link2 size={16} aria-hidden="true" />
                    <span>{creating ? t("user:actions.creating") : t("user:share.createLink")}</span>
                  </Button>
                </div>

                {/* The one moment the address exists in readable form: only its
                    hash is stored, so this row is not something the list below
                    can ever show again. */}
                {newLink && (
                  <div className="send-to-new-url">
                    <p>{t("user:share.copyNow")}</p>
                    <div className="send-to-url-row">
                      <input readOnly value={newLink.url} onFocus={(event) => event.target.select()} />
                      <Button variant="secondary" onClick={() => void copyUrl()}>
                        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                        <span>{copied ? t("user:share.copied") : t("user:actions.copy")}</span>
                      </Button>
                    </div>
                  </div>
                )}

                <h3 className="send-to-section-head">{t("user:sendTo.activeLinks")}</h3>
                {links.length === 0 ? (
                  <p className="send-to-empty">{t("user:share.noActiveLinks")}</p>
                ) : (
                  <ul className="send-to-rows">
                    {links.map((link) => (
                      <li key={link.id}>
                        <span className="send-to-row-icon" aria-hidden="true"><Link2 size={17} /></span>
                        <span className="send-to-row-main">
                          <strong>{link.label || t("user:share.guestLink")}</strong>
                          <span>
                            {link.status === "expired"
                              ? t("user:share.expired")
                              : t("user:share.expiresOn", { date: new Date(link.expiresAt).toLocaleDateString() })}
                          </span>
                        </span>
                        <Button variant="text" danger compact onClick={() => void revokeLink(link.id)}>
                          <Trash2 size={15} aria-hidden="true" />
                          <span>{t("user:share.revokeLink")}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <MessageBox tone="info" title={t("user:sendTo.linkTipTitle")}>{t("user:sendTo.linkTip")}</MessageBox>
              </div>
          )}

          {tab === "ereader" && destinations.ereader.applicable && (
            <div className="send-to-panel">
              {destinations.ereader.configured ? (
                <>
                  <p className="send-to-panel-intro">{t("user:sendTo.ereaderIntro")}</p>
                  <Button variant="primary" disabled={busy} onClick={() => void sendToEreader()}>
                    <Tablet size={16} aria-hidden="true" />
                    <span>{busy ? t("user:actions.sending") : t("user:sendTo.sendEreader")}</span>
                  </Button>
                </>
              ) : (
                <>
                  <p className="send-to-panel-intro">{t("user:sendTo.ereaderSetupIntro")}</p>
                  <a className="send-to-panel-link" href={profileHref("account")}>
                    {t("user:sendTo.routeEreaderSetup")}
                  </a>
                </>
              )}
            </div>
          )}
        </>
      )}
      {error && <MessageBox tone="error" title={t("user:common.errorTitle")}>{error}</MessageBox>}

      <div className="modal-actions send-to-footer">
        <a className="send-to-settings" href={profileHref("shares")}>
          <Settings size={16} aria-hidden="true" />
          <span>{t("user:sendTo.sharingSettings")}</span>
        </a>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        {tab === "people" && picked.length > 0 && (
          <Button variant="primary" onClick={() => setComposing(true)} disabled={busy}>
            <Send size={16} aria-hidden="true" />
            <span>{t("user:sendTo.sendToCount", { count: picked.length })}</span>
          </Button>
        )}
      </div>
    </Modal>
  );
}

function RouteTile({
  id,
  active,
  onPick,
  tone,
  icon,
  label,
  hint
}: {
  id: Tab;
  active: Tab;
  onPick: (tab: Tab) => void;
  /** Which of the three tints the circle wears — colour is what tells three
   *  same-shaped tiles apart at a glance. */
  tone: "people" | "link" | "ereader";
  icon: ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={`send-to-route${active === id ? " is-active" : ""}`}
      onClick={() => onPick(id)}
    >
      <span className={`send-to-route-icon ${tone}`} aria-hidden="true">{icon}</span>
      <strong>{label}</strong>
      <span>{hint}</span>
    </button>
  );
}

function PersonGrid({
  people,
  picked,
  onToggle
}: {
  people: Person[];
  picked: string[];
  onToggle?: (person: Person) => void;
}) {
  if (people.length === 0) return null;
  return (
    <ul className="send-to-people">
      {people.map((person) => (
        <PersonCard key={person.id} person={person} picked={picked.includes(person.id)} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function PersonCard({
  person,
  picked,
  onToggle
}: {
  person: Person;
  picked: boolean;
  onToggle?: (person: Person) => void;
}) {
  const { t } = useTranslation(["common", "user", "stories"]);
  return (
    <li>
      <button
        type="button"
        className={`send-to-person${picked ? " is-picked" : ""}`}
        aria-pressed={picked}
        disabled={!onToggle}
        onClick={() => onToggle?.(person)}
      >
        <Avatar name={person.displayName} />
        <span className="send-to-person-text">
          <strong>{person.displayName}</strong>
          <span>{person.email}</span>
          {!person.canOpen && (
            <span className="send-to-person-flag">
              {onToggle ? t("user:sendTo.willGetAccess") : t("user:sendTo.noAccess")}
            </span>
          )}
          {person.canOpen && person.alreadySent && (
            <span className="send-to-person-flag">{t("user:sendTo.alreadySent")}</span>
          )}
        </span>
        {/* Drawn, not an <input>: the whole card is the control, and a real
            checkbox inside a button is neither valid nor reachable twice. */}
        <span className="send-to-check" aria-hidden="true" />
      </button>
    </li>
  );
}

// Nobody has a portrait on this server — there is no user photo anywhere in the
// product — so the circle carries initials, tinted from the name so the same
// person is the same colour on every screen they appear on.
function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return (
    <span className="send-to-avatar" style={{ "--avatar-hue": hash } as CSSProperties} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

/** "Ann", "Ann & Bo", "Ann, Bo & Cy" — a list a sentence can hold. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function SubjectCard({ subject }: { subject: Destinations["subject"] }) {
  return (
    <div className="send-to-subject">
      {subject.coverUrl
        ? <img src={subject.coverUrl} alt="" className="send-to-subject-cover" />
        : <span className="send-to-subject-cover send-to-subject-cover-empty" aria-hidden><Send size={16} /></span>}
      <span className="send-to-subject-text">
        <strong>{subject.title}</strong>
        {subject.subtitle && <span>{subject.subtitle}</span>}
      </span>
    </div>
  );
}
