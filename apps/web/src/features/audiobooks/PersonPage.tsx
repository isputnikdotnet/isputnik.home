import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Globe, Headphones, MapPin, Merge, Pencil, Search, UserRound, type LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../../api";
import i18n from "../../i18n";
import { DashboardShell } from "../../app/DashboardShell";
import { getReferrer, goBack, navigate, queryParam, replaceQuery } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { SectionNav } from "../../shared/SectionNav";
import { formatDuration } from "../../shared/utils";
import { sectionFromHref, sectionNavProps } from "./sectionNavItems";
import { PersonProfileModal } from "./PersonProfileModal";

// One item this person is credited on, in any media type / any accessible
// library. `role` is how they're credited on this specific item. narrators is
// audiobook credits only (empty for ebooks); like `authors`, it lists everyone
// in that role on the item, including this person themself when that's the
// role being shown.
type PersonItem = {
  id: string;
  type: "audiobook" | "ebook";
  role: string;
  title: string;
  authors: string[];
  narrators: string[];
  durationSeconds: number | null;
  yearPublished: number | null;
  coverUrl: string | null;
};

type PersonProfileInfo = {
  bio: string | null;
  website: string | null;
  location: string | null;
  photoUrl: string | null;
};

// A bare domain like "agriddle.com" is what a profile stores and what the
// mockup shows — add a protocol only for the actual href, so the link works
// without forcing anyone to type "https://" into the field.
const websiteHref = (website: string) => (/^https?:\/\//i.test(website) ? website : `https://${website}`);

// Role keys the server may send; anything else falls back to a capitalized
// echo of the raw role rather than a translation lookup.
const ROLE_KEYS: Record<string, "roleAuthor" | "roleNarrator" | "roleEditor" | "roleArtist" | "rolePhotographer" | "roleContributor"> = {
  author: "roleAuthor",
  narrator: "roleNarrator",
  editor: "roleEditor",
  artist: "roleArtist",
  photographer: "rolePhotographer",
  contributor: "roleContributor"
};

// Built fresh on every call (not a module-level lookup) so it stays reactive
// to a language switch — same approach as control/nav.ts.
const roleLabel = (role: string) => {
  const key = ROLE_KEYS[role];
  return key ? i18n.t(`book:personPage.${key}`) : role.charAt(0).toUpperCase() + role.slice(1);
};
const typeLabel = (type: string) => (type === "ebook" ? i18n.t("common:mediaKind.ebook") : i18n.t("common:mediaKind.audiobook"));
const typeIcon = (type: string): LucideIcon => (type === "ebook" ? BookOpen : Headphones);
const bookHref = (item: PersonItem) =>
  item.type === "ebook" ? `/ebooks/books/${item.id}` : `/audiobooks/books/${item.id}`;

type PersonTab = "overview" | "books" | "audiobooks";

function personTabs(): { id: PersonTab; label: string; icon: LucideIcon }[] {
  return [
    { id: "overview", label: i18n.t("book:personPage.tabOverview"), icon: UserRound },
    { id: "books", label: i18n.t("book:personPage.tabBooks"), icon: BookOpen },
    { id: "audiobooks", label: i18n.t("common:nav.audiobooks"), icon: Headphones }
  ];
}

// The canonical, cross-type person page. People are global (one DB row per
// name), so this shows everything a person made — audiobooks and ebooks —
// across an Overview/Books/Audiobooks tab menu, the same tab strip a book's
// own detail page uses. Reached via /people/:name and the legacy per-type
// author/narrator paths, which all render this component.
export function PersonPage({
  personName,
  user,
  logout
}: {
  personName: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [items, setItems] = useState<PersonItem[]>([]);
  const [profile, setProfile] = useState<PersonProfileInfo | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeNames, setMergeNames] = useState<string[]>([]);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeQuery, setMergeQuery] = useState("");
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");
  // A stored photoUrl that 404s (deleted file, bad online-lookup URL) falls
  // back to the initial letter instead of a broken-image icon — same as the
  // family tree's PersonAvatar.
  const [photoBroken, setPhotoBroken] = useState(false);
  // ?tab= so a tab reads back on reload/share, without pushing a history entry
  // per click — same replaceQuery treatment as the A–Z strip's ?letter.
  const [activeTab, setActiveTab] = useState<PersonTab>(() => {
    const requested = queryParam("tab");
    return requested === "books" || requested === "audiobooks" ? requested : "overview";
  });

  const backTo = getReferrer();
  // The page spans types, so it has no section of its own — it borrows the one
  // whose list sent the visitor here, so stepping in and back out of a person
  // doesn't swap the left nav underneath them. Reached without a trail (a
  // bookmark, a link from Tags), there's nothing to borrow and the generic nav
  // stands, same as every other cross-type page.
  const section = sectionFromHref(backTo);
  const dashActive = section?.active ?? "audiobooks";
  const sectionKey = backTo?.startsWith("/audiobooks/narrators") ? "narrators" : "authors";

  // Photo + bio for the header; re-fetched after the profile modal closes so
  // edits show up immediately.
  const loadProfile = useCallback(async () => {
    try {
      const payload = await api<{ person: PersonProfileInfo | null }>(
        `/api/library/people/by-name?name=${encodeURIComponent(personName)}`
      );
      setProfile(payload.person ?? null);
      setPhotoBroken(false); // give a just-changed photo a fresh chance to load
    } catch {
      setProfile(null); // header degrades to the placeholder icon
    }
  }, [personName]);

  useEffect(() => {
    // A different person: land back on Overview rather than carrying over
    // whichever tab was open on the last one, and give their photo a fresh
    // chance to load rather than keeping the last one's broken flag.
    setActiveTab("overview");
    replaceQuery("tab", null);
    setPhotoBroken(false);
    api<{ items: PersonItem[] }>(`/api/library/people/by-name/items?name=${encodeURIComponent(personName)}`)
      .then((payload) => setItems(payload.items))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:catalog.unableLoadData")));
    void loadProfile();
    // Merge candidates come from the global people list (admins only need it).
    if (user.role === "admin") {
      api<{ names: string[] }>("/api/library/people/names")
        .then((payload) => setMergeNames(payload.names))
        .catch(() => {}); // merge just stays unavailable if this fails
    }
  }, [personName, loadProfile, user.role]);

  const chooseTab = (tab: PersonTab) => {
    setActiveTab(tab);
    replaceQuery("tab", tab === "overview" ? null : tab);
  };

  const personInitial = personName.trim().charAt(0).toUpperCase();

  // The distinct roles this person is credited in, preserving the server's
  // ordering (author, narrator, …), for the "Author, Narrator · N titles"
  // subtitle under the name.
  const roles: string[] = [];
  for (const item of items) {
    if (!roles.includes(item.role)) roles.push(item.role);
  }

  // What to call this person in the edit dialog's title. Author wins when they
  // are one — most people here are — and someone credited only as a narrator
  // gets "Edit Narrator". Anyone else (editor, artist, no credits yet) falls
  // through to the dialog's generic "Edit Person".
  const editRole = roles.includes("author") ? "author" as const
    : roles.includes("narrator") ? "narrator" as const
    : undefined;
  const subtitle = [
    roles.map(roleLabel).join(", "),
    t("book:catalog.counts.title", { count: items.length })
  ].filter(Boolean).join(" · ");

  const visibleItems = activeTab === "overview"
    ? items
    : items.filter((item) => item.type === (activeTab === "books" ? "ebook" : "audiobook"));
  const emptyMessage = activeTab === "books" ? t("book:personPage.noneYetEbooks")
    : activeTab === "audiobooks" ? t("book:personPage.noneYetAudiobooks")
    : t("book:personPage.noneYetTitles");

  const mergeCandidates = mergeNames.filter((name) => name !== personName);
  const filteredCandidates = mergeQuery.trim()
    ? mergeCandidates.filter((name) => name.toLowerCase().includes(mergeQuery.trim().toLowerCase()))
    : mergeCandidates;

  const runMerge = async () => {
    if (!mergeTarget) return;
    setMerging(true);
    setError("");
    try {
      await api("/api/library/people/merge", {
        method: "POST",
        body: JSON.stringify({ from: personName, into: mergeTarget })
      });
      setMergeOpen(false);
      setMerging(false);
      navigate(`/people/${encodeURIComponent(mergeTarget)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:personPage.mergeFailed"));
      setMerging(false);
    }
  };

  return (
    <DashboardShell
      active={dashActive}
      user={user}
      logout={logout}
      sideNav={section && <SectionNav {...sectionNavProps(section)} activeKey={sectionKey} />}
    >
      <section className="book-detail-view person-detail-view">
        {/* Same icon topbar as a book's and a family member's — the app's
            standard for an item detail page: icon Back, divider, then every
            action this page offers, icon-only. */}
        <div className="book-detail-topbar">
          <button
            className="icon-button"
            type="button"
            onClick={() => goBack(backTo ?? "/authors")}
            aria-label={backTo ? t("book:catalog.back") : t("book:authors.backToAuthors")}
            title={backTo ? t("book:catalog.back") : t("book:authors.backToAuthors")}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <span className="library-toolbar-divider" aria-hidden="true" />
          <div className="book-detail-secondary-actions" aria-label={t("book:personPage.actionsAria")}>
            <Button
              variant="icon"
              onClick={() => setProfileModalOpen(true)}
              title={t("book:personPage.editProfileAria")}
              aria-label={t("book:personPage.editProfileAria")}
            >
              <Pencil size={18} aria-hidden="true" />
            </Button>
            {user.role === "admin" && mergeCandidates.length > 0 && (
              <Button
                variant="icon"
                onClick={() => { setMergeTarget(""); setMergeQuery(""); setMergeOpen(true); }}
                title={t("book:personPage.mergeAria")}
                aria-label={t("book:personPage.mergeAria")}
              >
                <Merge size={18} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        {/* Same "big round cover beside the details" grid a family member's
            page uses (book-detail-head/cover + ft-person-detail-* + the
            ft-avatar ring), reused wholesale by class name rather than
            importing that feature's gender-aware avatar component. */}
        <div className="book-detail-head ft-person-detail-head">
          <div className="book-detail-cover-col ft-person-detail-cover-col">
            <div className="book-detail-cover ft-person-detail-cover" aria-hidden="true">
              {/* Same fallback ladder as the family tree's PersonAvatar: photo,
                  else the initial letter (matching size — that component reads
                  its `size` prop where this reads the fixed 220px the cover box
                  is styled to), else a generic person icon for a nameless one. */}
              <span className="ft-avatar">
                {profile?.photoUrl && !photoBroken ? (
                  <img src={profile.photoUrl} alt="" onError={() => setPhotoBroken(true)} />
                ) : personInitial ? (
                  <span className="ft-avatar-initial" style={{ fontSize: 220 * 0.42 }}>{personInitial}</span>
                ) : (
                  <UserRound size={72} />
                )}
              </span>
            </div>
          </div>

          <div className="book-detail-info">
            <h1 className="book-detail-title">{personName}</h1>
            {subtitle && <p className="book-detail-author person-detail-subtitle">{subtitle}</p>}
            {profile?.bio && <p className="person-bio">{profile.bio}</p>}

            {(profile?.website || profile?.location) && (
              <dl className="book-detail-meta-grid">
                {profile?.website && (
                  <div className="book-detail-meta-item">
                    <Globe size={18} aria-hidden="true" />
                    <dt>{t("book:person.fieldWebsite")}</dt>
                    <dd><a href={websiteHref(profile.website)} target="_blank" rel="noreferrer">{profile.website}</a></dd>
                  </div>
                )}
                {profile?.location && (
                  <div className="book-detail-meta-item">
                    <MapPin size={18} aria-hidden="true" />
                    <dt>{t("book:person.fieldLocation")}</dt>
                    <dd>{profile.location}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </div>

        {error && <MessageBox tone="error" title={t("book:detail.errorTitle")}>{error}</MessageBox>}

        {/* The same tab strip a book's own detail page uses (Description /
            Chapters / …), here switching between everything, ebooks only and
            audiobooks only. */}
        <section className="book-detail-tabs-section">
          <nav className="book-detail-tabs person-detail-tabs" aria-label={t("book:personPage.sectionsAria")}>
            {personTabs().map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "active" : ""}
                onClick={() => chooseTab(tab.id)}
              >
                <tab.icon size={16} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          <div className="book-detail-tab-panel">
            <div className="person-titles-panel">
              <h2>{t("book:personPage.titlesHeading")}</h2>
              {visibleItems.length === 0 ? (
                <p className="management-empty">{emptyMessage}</p>
              ) : (
                <div className="person-title-grid">
                  {visibleItems.map((item) => (
                    <PersonTitleRow key={`${item.role}:${item.id}`} item={item} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </section>

      {profileModalOpen && (
        <PersonProfileModal
          personName={personName}
          role={editRole}
          onClose={() => {
            setProfileModalOpen(false);
            void loadProfile();
          }}
        />
      )}

      {mergeOpen && (
        <Modal title={t("book:personPage.mergeModalTitle", { name: personName })} className="merge-modal" busy={merging} onClose={() => setMergeOpen(false)}>
          <p>
            <Trans
              i18nKey="personPage.mergeIntro"
              ns="book"
              count={items.length}
              values={{ name: personName }}
              components={{ bold: <strong /> }}
            />
          </p>
          <label className="facet-search merge-search">
            <Search size={14} aria-hidden="true" />
            <input
              value={mergeQuery}
              onChange={(e) => setMergeQuery(e.target.value)}
              placeholder={t("book:personPage.searchPeople")}
              aria-label={t("book:personPage.searchPeople")}
              autoFocus
            />
          </label>
          <div className="merge-candidate-list">
            {filteredCandidates.map((name) => (
              <button
                key={name}
                className={`merge-candidate${mergeTarget === name ? " selected" : ""}`}
                onClick={() => setMergeTarget(name)}
              >
                {name}
              </button>
            ))}
            {filteredCandidates.length === 0 && <p className="facet-empty">{t("common:filters.noMatches")}</p>}
          </div>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setMergeOpen(false)} disabled={merging}>{t("common:common.cancel")}</Button>
            <Button variant="primary" onClick={runMerge} disabled={merging || !mergeTarget}>
              <Merge size={15} /> {merging ? t("book:personPage.merging") : t("book:personPage.mergeButton")}
            </Button>
          </div>
        </Modal>
      )}
    </DashboardShell>
  );
}

// One row in the Titles grid: cover, title, then whichever of the item's OTHER
// credits and facts are worth showing — the credited people this person page's
// own name would just repeat are left out (the author on an author's own rows,
// the narrator on a narrator's own rows).
function PersonTitleRow({ item }: { item: PersonItem }) {
  const { t } = useTranslation(["common", "book"]);
  const Icon = typeIcon(item.type);
  const creditLine = item.role === "narrator"
    ? (item.authors.length > 0 ? t("book:metadata.byAuthors", { authors: item.authors.join(", ") }) : null)
    : item.type === "audiobook" && item.narrators.length > 0
      ? t("book:personPage.narratedByPrefix", { narrators: item.narrators.join(", ") })
      : (item.role !== "author" && item.authors.length > 0 ? t("book:metadata.byAuthors", { authors: item.authors.join(", ") }) : null);
  const durationText = item.type === "audiobook" && item.durationSeconds != null
    ? formatDuration(item.durationSeconds)
    : null;

  return (
    <button className="person-title-row" onClick={() => navigate(bookHref(item))}>
      <div className="person-title-cover" aria-hidden="true">
        {item.coverUrl ? <img src={item.coverUrl} alt="" /> : <Icon size={26} />}
      </div>
      <div className="person-title-info">
        <strong>{item.title}</strong>
        <span className="person-title-meta">
          <Icon size={16} aria-hidden="true" />
          {typeLabel(item.type)}
        </span>
        {(creditLine || durationText) && (
          <span className="person-title-meta">
            {creditLine}
            {creditLine && durationText && <i className="person-title-sep" aria-hidden="true" />}
            {durationText}
          </span>
        )}
        {item.yearPublished != null && <span className="person-title-meta">{t("book:personPage.publishedYear", { year: item.yearPublished })}</span>}
      </div>
    </button>
  );
}
