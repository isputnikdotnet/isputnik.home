import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  BookMarked,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  ImagePlus,
  Link2,
  Pencil,
  Save,
  Search,
  Trash2,
  UserRound
} from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "../../shared/PartialDateField";
import { PersonPhotoModal } from "./PersonPhotoModal";
import { formatLifespan } from "./types";

// Life facts, on the profile and on every lookup result alike — the modal
// compares the two field by field, so they have to be the same shape.
type PersonFacts = {
  // Partial dates: "1899", "1899-07", "1899-07-21".
  birthDate: string | null;
  deathDate: string | null;
  country: string | null;
  occupation: string | null;
  // Only lookup results carry this; a saved profile keeps it alongside.
  wikipediaUrl?: string | null;
};

type PersonProfile = PersonFacts & {
  name: string;
  sortName: string | null;
  bio: string | null;
  website: string | null;
  location: string | null;
  photoUrl: string | null;
  wikipediaUrl: string | null;
};

const NO_PROFILE_FACTS = { birthDate: null, deathDate: null, country: null, occupation: null };

// Current vs found, field by field — the same table the book dialog puts behind
// its Details button, so "what would applying this actually change" is answered
// the same way in both dialogs.
function PersonResultCompare({
  candidate,
  current,
  currentPhotoUrl,
  brokenPhotos,
  onPhotoError
}: {
  candidate: PersonLookupCandidate;
  current: { birthDate: string; deathDate: string; country: string; occupation: string; bio: string };
  currentPhotoUrl: string | null;
  brokenPhotos: string[];
  onPhotoError: (url: string) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const rows = [
    { label: t("book:person.fieldBorn"), current: current.birthDate, next: candidate.facts.birthDate ?? "" },
    { label: t("book:person.fieldDied"), current: current.deathDate, next: candidate.facts.deathDate ?? "" },
    { label: t("book:person.fieldCountry"), current: current.country, next: candidate.facts.country ?? "" },
    { label: t("book:person.fieldOccupation"), current: current.occupation, next: candidate.facts.occupation ?? "" },
    { label: t("book:person.fieldBiography"), current: current.bio, next: candidate.bio ?? "" }
  ];
  const changed = (a: string, b: string) => b.trim().length > 0 && b.trim() !== a.trim();
  const visible = rows.filter((row) => row.current.trim() || row.next.trim());
  const nextPhoto = candidate.photoUrl && !brokenPhotos.includes(candidate.photoUrl) ? candidate.photoUrl : null;

  return (
    <div className="metadata-result-compare">
      <div className="compare-row compare-head-row" aria-hidden="true">
        <span></span>
        <span>{t("book:compare.current")}</span>
        <span>{t("book:compare.fromResult")}</span>
      </div>
      {visible.map((row) => (
        <div className={`compare-row${changed(row.current, row.next) ? " changed" : ""}`} key={row.label}>
          <span className="compare-label">{row.label}</span>
          <span className="compare-current">{row.current || "—"}</span>
          <span className="compare-next">
            {row.next || "—"}
            {changed(row.current, row.next) && <em className="compare-flag">{t("book:compare.changes")}</em>}
          </span>
        </div>
      ))}
      <div className="compare-row compare-cover-row">
        <span className="compare-label">{t("book:person.photo")}</span>
        <span className="compare-current">
          <span className="compare-cover-frame">
            {currentPhotoUrl ? <img src={currentPhotoUrl} alt="" /> : <UserRound size={20} />}
          </span>
        </span>
        <span className="compare-next">
          <span className="compare-cover-frame">
            {nextPhoto
              ? <img src={nextPhoto} alt="" onError={() => onPhotoError(nextPhoto)} />
              : <UserRound size={20} />}
          </span>
        </span>
      </div>
    </div>
  );
}

type PersonLookupCandidate = {
  id: string;
  title: string;
  description: string | null;
  bio: string | null;
  photoUrl: string | null;
  source: "wikipedia" | "openlibrary";
  sourceUrl: string | null;
  facts: PersonFacts;
  // Only what tells two same-name results apart — the facts above are the part
  // worth keeping.
  details: {
    language?: string;
    pageTitle?: string;
    topWork?: string;
    workCount?: number;
    olid?: string;
  };
};



// Mirrors PersonLookupSource on the server: which of the two person sources to
// ask. Kept in step with modules/library/audiobook/enrich.ts.
type PersonLookupSource = "all" | "wikipedia" | "openlibrary";

type Tab = "details" | "biography" | "photo" | "find";

const TAB_KEYS: Record<Tab, "tabDetails" | "tabBiography" | "photo" | "tabFind"> = {
  details: "tabDetails",
  biography: "tabBiography",
  photo: "photo",
  find: "tabFind"
};
const TABS: Tab[] = ["details", "biography", "photo", "find"];

// Edit one person's profile. Details carries the identity fields plus the photo
// tile (which opens PersonPhotoModal — choosing a picture is its own box, since
// it has two whole sources of its own); Biography is the long text on its own;
// Find Info looks the person up online and offers what it found field by field.
//
// Find Info is a SHORTLIST, not a verdict: the server answers with every page
// that could be this person (Wikipedia per language, Open Library records), the
// list on the left picks one, and the pane on the right compares that one
// against what the profile already holds. Same-name people are common enough
// that a single auto-chosen answer was regularly the wrong one, with no way to
// see that it was wrong, let alone reach the right one.
export function PersonProfileModal({
  personName,
  role,
  onClose
}: {
  personName: string;
  // A person can be credited in several roles across types, so the profile
  // itself is role-agnostic; the prop only tweaks the dialog title.
  role?: "author" | "narrator";
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [tab, setTab] = useState<Tab>("details");
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [name, setName] = useState(personName);
  const [sortName, setSortName] = useState("");
  const [website, setWebsite] = useState("");
  const [location, setLocation] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [deathDate, setDeathDate] = useState("");
  const [country, setCountry] = useState("");
  const [occupation, setOccupation] = useState("");
  // Not a field anyone types into — it rides along with the facts, so the
  // source link on the person's page survives a hand-applied result.
  const [wikipediaUrl, setWikipediaUrl] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBoxOpen, setPhotoBoxOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The photo tile takes a dropped file directly — clicking it opens the box
  // (which also offers Find online), but a drag doesn't need the detour.
  const [tileDragging, setTileDragging] = useState(false);
  const [tileUploading, setTileUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [finding, setFinding] = useState(false);
  const [lookingUpLink, setLookingUpLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [candidates, setCandidates] = useState<PersonLookupCandidate[]>([]);
  // What to search for, and where. The stored name is only a starting point: a
  // person filed as "Twain, Mark" finds nothing searched verbatim, and until now
  // there was no way to say so.
  const [searchQuery, setSearchQuery] = useState(personName);
  const [source, setSource] = useState<PersonLookupSource>("all");
  // What Apply takes from a result. All three on by default — the common case is
  // "this is the right person, take everything".
  const [takeFacts, setTakeFacts] = useState(true);
  const [takeBio, setTakeBio] = useState(true);
  const [takePhoto, setTakePhoto] = useState(true);
  // The card whose compare table is open, and the last one applied (so its
  // button can say so). Both single-value: two open tables at once is what made
  // the old panel unreadable.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  // Whether a search has run at all: before it, the tab is an invitation; after
  // it, a result strip. Distinct from "found nothing", which is a real answer.
  const [searched, setSearched] = useState(false);
  // Candidate photo URLs that failed to load. Open Library answers 404 rather
  // than serving a placeholder when a record has no picture, so the URL only
  // reveals itself as empty once the browser has tried it.
  const [brokenPhotos, setBrokenPhotos] = useState<string[]>([]);
  // A photo chosen on Find Info is STAGED, not written: it is applied by Save
  // alongside the text fields. Anything else in this dialog that changes the
  // photo (the box, a drop, Remove) writes immediately and clears this, so the
  // two can never both be pending.
  const [pendingPhotoUrl, setPendingPhotoUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "success"; title: string; text: string } | null>(null);

  const query = `name=${encodeURIComponent(personName)}`;

  useEffect(() => {
    api<{ person: PersonProfile | null }>(`/api/library/people/by-name?${query}`)
      .then((payload) => {
        const p = payload.person
          ?? {
            ...NO_PROFILE_FACTS,
            name: personName,
            sortName: null,
            bio: null,
            website: null,
            location: null,
            photoUrl: null,
            wikipediaUrl: null
          };
        setProfile(p);
        setName(p.name);
        setSortName(p.sortName ?? "");
        setWebsite(p.website ?? "");
        setLocation(p.location ?? "");
        setBirthDate(p.birthDate ?? "");
        setDeathDate(p.deathDate ?? "");
        setCountry(p.country ?? "");
        setOccupation(p.occupation ?? "");
        setWikipediaUrl(p.wikipediaUrl);
        setBio(p.bio ?? "");
        setPhotoUrl(p.photoUrl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("book:person.unableLoadProfile")));
  }, [personName]);

  const handleSave = async () => {
    const newName = name.trim();
    if (!newName) return;
    setSaving(true);
    setError("");
    try {
      // The staged photo first: it is a download on the server, so if it fails
      // the profile edit is still untouched and the error names the photo.
      if (pendingPhotoUrl) {
        await api(`/api/library/people/by-name/photo-from-url?${query}`, {
          method: "POST",
          body: JSON.stringify({ url: pendingPhotoUrl })
        });
        setPendingPhotoUrl(null);
      }
      await api(`/api/library/people/by-name?${query}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: newName,
          bio: bio.trim() || null,
          sortName: sortName.trim() || null,
          website: website.trim() || null,
          location: location.trim() || null,
          birthDate: birthDate.trim() || null,
          deathDate: deathDate.trim() || null,
          country: country.trim() || null,
          occupation: occupation.trim() || null,
          wikipediaUrl
        })
      });
      onClose();
      if (newName !== personName) {
        navigate(`/people/${encodeURIComponent(newName)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:person.saveFailed"));
      setSaving(false);
    }
  };

  // A file dropped straight onto the tile. Same endpoint and same limits the
  // photo box's Upload tab uses — checked here too so a bad drop fails before
  // the bytes go over the wire.
  const uploadDropped = async (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError(t("book:person.dropTypeError"));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(t("book:person.tooLarge"));
      return;
    }
    setTileUploading(true);
    setError("");
    try {
      const result = await api<{ updated: boolean; photoUrl: string }>(`/api/library/people/by-name/photo?${query}`, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: await file.arrayBuffer()
      });
      setPhotoUrl(result.photoUrl);
      setPendingPhotoUrl(null); // a real upload supersedes anything staged on Find Info
      setProfile((prev) => prev ? { ...prev, photoUrl: result.photoUrl } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:person.uploadFailed"));
    } finally {
      setTileUploading(false);
    }
  };

  const removePhoto = async () => {
    setRemoving(true);
    setError("");
    try {
      await api(`/api/library/people/by-name/photo?${query}`, { method: "DELETE" });
      setPhotoUrl(null);
      setPendingPhotoUrl(null); // removing beats a staged pick
      setProfile((prev) => prev ? { ...prev, photoUrl: null } : prev);
      setRemoveOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:person.unableRemovePhoto"));
    } finally {
      setRemoving(false);
    }
  };

  // Preview matches without writing anything — by search text, or from a pasted
  // Wikipedia / Open Library link (which simply returns a one-entry list, so the
  // rest of the tab has a single shape to render). `name` still identifies the
  // person; `q` is what gets searched.
  const runLookup = async (url?: string) => {
    setError("");
    setNotice(null);
    const search = url
      ? `${query}&url=${encodeURIComponent(url)}`
      : `${query}&q=${encodeURIComponent(searchQuery.trim() || personName)}&source=${source}`;
    const result = await api<{ candidates: PersonLookupCandidate[] }>(`/api/library/people/by-name/lookup?${search}`);
    const found = result.candidates ?? [];
    setCandidates(found);
    setExpandedId(null);
    setAppliedId(null);
    setSearched(true);
    if (found.length === 0) {
      setNotice({
        tone: "info",
        title: t("book:person.noMatchTitle"),
        text: url ? t("book:person.noMatchLink") : t("book:person.noMatchName")
      });
    }
  };

  const markPhotoBroken = (url: string) => {
    setBrokenPhotos((broken) => (broken.includes(url) ? broken : [...broken, url]));
  };

  const handleFindOnline = async () => {
    setFinding(true);
    try {
      await runLookup();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:person.lookupFailed"));
    } finally {
      setFinding(false);
    }
  };

  const handleLookupLink = async () => {
    if (!linkUrl.trim()) return;
    setLookingUpLink(true);
    try {
      await runLookup(linkUrl.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("book:person.linkReadFailed"));
    } finally {
      setLookingUpLink(false);
    }
  };

  // "Open Library" / "Wikipedia" are proper nouns and stay untranslated in
  // every language.
  const sourceLabel = (source: PersonLookupCandidate["source"]) =>
    source === "openlibrary" ? "Open Library" : "Wikipedia";

  // Applying a result stages it into the form; nothing is written until Save.
  // That is deliberately unlike the book dialog, which applies straight to the
  // server — this one has a Save button and a Cancel that must still mean it.
  const applyCandidate = (entry: PersonLookupCandidate) => {
    if (takeFacts) {
      if (entry.facts.birthDate) setBirthDate(entry.facts.birthDate);
      if (entry.facts.deathDate) setDeathDate(entry.facts.deathDate);
      if (entry.facts.country) setCountry(entry.facts.country);
      if (entry.facts.occupation) setOccupation(entry.facts.occupation);
      if (entry.facts.wikipediaUrl) setWikipediaUrl(entry.facts.wikipediaUrl);
    }
    if (takeBio && entry.bio) {
      setBio(entry.bio);
    }
    if (takePhoto && entry.photoUrl && !brokenPhotos.includes(entry.photoUrl)) {
      setPendingPhotoUrl(entry.photoUrl);
      setPhotoUrl(entry.photoUrl); // preview only; the server still holds the old one
    }
    setAppliedId(entry.id);
  };

  // How much of the form differs from what is stored — the "N changes ready to
  // save" line. Measured against the SAVED profile, never against a result, so
  // applying a second card can't make the first one look undone.
  const factsChanged = [
    [birthDate, profile?.birthDate],
    [deathDate, profile?.deathDate],
    [country, profile?.country],
    [occupation, profile?.occupation]
  ].some(([current, saved]) => (current ?? "").trim() !== (saved ?? ""));
  const stagedCount = (bio.trim() !== (profile?.bio ?? "").trim() ? 1 : 0)
    + (pendingPhotoUrl ? 1 : 0)
    + (factsChanged ? 1 : 0);

  const modalTitle = role === "author"
    ? t("book:person.editAuthor")
    : role === "narrator"
      ? t("book:person.editNarrator")
      : t("book:person.editPerson");
  const busy = saving || removing || finding || lookingUpLink || tileUploading;

  return (
    <>
      <Modal
        variant="panel"
        title={modalTitle}
        icon={<Pencil size={22} />}
        className="person-edit-modal"
        // The photo box opens on top of this one; both listen for Escape on the
        // document, so without this a single press would close them together.
        busy={busy || photoBoxOpen || removeOpen}
        onClose={onClose}
      >
        <div className="modal-tabs">
          {TABS.map((id) => (
            <button
              key={id}
              className={`modal-tab${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              {t(`book:person.${TAB_KEYS[id]}`)}
            </button>
          ))}
        </div>

        <div className="modal-tab-content">
          {error && <MessageBox tone="error" title={t("book:person.updateErrorTitle")}>{error}</MessageBox>}
          {notice && <MessageBox tone={notice.tone} title={notice.title}>{notice.text}</MessageBox>}

          {/* The same field grid the book metadata dialog wears: these two do
              the same job — editing one library object's metadata — so they
              should read as one dialog with different fields in it. */}
          {tab === "details" && (
            <div className="metadata-edit-grid">
              <label className="field metadata-field-wide">
                <span>{t("book:person.fieldName")} <b className="person-edit-req" aria-hidden="true">*</b></span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("book:person.fullName")} required />
              </label>
              <label className="field metadata-field-half">
                <span>{t("book:person.fieldSortName")}</span>
                <input
                  value={sortName}
                  onChange={(e) => setSortName(e.target.value)}
                  placeholder={t("book:person.sortExample", { example: personName.split(" ").reverse().join(", ") })}
                />
              </label>
              <label className="field metadata-field-half">
                <span>{t("book:person.fieldWebsite")}</span>
                <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://agriddle.com" />
              </label>
              {/* Born and Died are partial dates: a bare year is the usual
                  answer for an author, and a native date input cannot express
                  one. */}
              <PartialDateField
                className="metadata-field-half"
                label={t("book:person.fieldBorn")}
                value={birthDate}
                placeholder={t("book:person.bornExample")}
                onChange={setBirthDate}
              />
              <PartialDateField
                className="metadata-field-half"
                label={t("book:person.fieldDied")}
                value={deathDate}
                placeholder={t("book:person.diedExample")}
                onChange={setDeathDate}
              />
              <label className="field metadata-field-half">
                <span>{t("book:person.fieldCountry")}</span>
                <input
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder={t("book:person.countryExample")}
                />
              </label>
              <label className="field metadata-field-half">
                <span>{t("book:person.fieldOccupation")}</span>
                <input
                  value={occupation}
                  onChange={(e) => setOccupation(e.target.value)}
                  placeholder={t("book:person.occupationExample")}
                />
              </label>
              <label className="field metadata-field-wide">
                <span>{t("book:person.fieldLocation")}</span>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={t("book:person.locationExample")}
                />
              </label>
            </div>
          )}

          {/* A person's photo is their cover, and it gets the tab a book's cover
              gets — which is what leaves the details above as one plain grid. */}
          {tab === "photo" && (
            <div className="person-edit-photo-tab">
              <div className="person-edit-photo-col">
                <span className="person-edit-label">{t("book:person.photo")}</span>
                {/* The tile is the way in to the photo box rather than a file
                    input of its own — choosing a picture has two sources, so it
                    gets a box instead of a hidden <input> behind a dashed frame. */}
                <button
                  type="button"
                  className={`person-edit-photo-tile${tileDragging ? " dragging" : ""}`}
                  onClick={() => setPhotoBoxOpen(true)}
                  title={t("book:person.choosePhotoTitle")}
                  onDragOver={(event) => { event.preventDefault(); setTileDragging(true); }}
                  onDragLeave={() => setTileDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setTileDragging(false);
                    void uploadDropped(event.dataTransfer.files?.[0]);
                  }}
                >
                  {photoUrl ? (
                    <img src={photoUrl} alt="" />
                  ) : (
                    <>
                      <UserRound size={46} aria-hidden="true" />
                      <span className="person-edit-photo-title">
                        {tileUploading ? t("book:person.uploading") : <>{t("book:person.dragDrop")}<br />{t("book:person.orClickToUpload")}</>}
                      </span>
                      <span className="person-edit-photo-hint">{t("book:person.photoFormats")}<br />{t("book:person.photoMaxSize")}</span>
                    </>
                  )}
                </button>
                {photoUrl ? (
                  <Button variant="secondary" danger className="person-edit-photo-button" onClick={() => setRemoveOpen(true)}>
                    <Trash2 size={16} aria-hidden="true" />
                    <span>{t("book:person.removePhoto")}</span>
                  </Button>
                ) : (
                  <Button variant="secondary" className="person-edit-photo-button" onClick={() => setPhotoBoxOpen(true)}>
                    <ImagePlus size={16} aria-hidden="true" />
                    <span>{t("book:person.choosePhoto")}</span>
                  </Button>
                )}
              </div>
            </div>
          )}

          {tab === "biography" && (
            <label className="field">
              <span>{t("book:person.fieldBiography")}</span>
              <textarea
                rows={12}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t("book:person.bioPlaceholder")}
                maxLength={10000}
              />
            </label>
          )}

          {/* The book metadata dialog's lookup, row for row: where to search,
              what to take from a result, and a link for when you already know
              the page. The person sources differ; the shape does not. */}
          {tab === "find" && (
            <>
              <div className="metadata-search-row">
                <select
                  className="library-filter"
                  value={source}
                  onChange={(e) => setSource(e.target.value as PersonLookupSource)}
                  aria-label={t("book:person.sourceAria")}
                >
                  <option value="all">{t("book:metadata.allProviders")}</option>
                  <option value="wikipedia">Wikipedia</option>
                  <option value="openlibrary">Open Library</option>
                </select>
                <label className="search-field">
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleFindOnline(); }}
                    placeholder={t("book:person.searchPlaceholder")}
                    aria-label={t("book:person.searchAria")}
                  />
                </label>
                <Button
                  variant="primary"
                  className="metadata-search-button"
                  onClick={() => void handleFindOnline()}
                  disabled={finding || !searchQuery.trim()}
                >
                  <Search size={16} aria-hidden="true" />
                  <span>{finding ? t("book:person.searching") : t("book:metadata.search")}</span>
                </Button>
              </div>

              {/* What Apply takes — the person's answer to the book dialog's
                  "update details / update cover" pair, and the replacement for
                  the three per-field "use this one" buttons that were here. */}
              <div className="metadata-apply-controls">
                <label>
                  <input type="checkbox" checked={takeFacts} onChange={(e) => setTakeFacts(e.target.checked)} />
                  <span>{t("book:person.takeFacts")}</span>
                </label>
                <label>
                  <input type="checkbox" checked={takeBio} onChange={(e) => setTakeBio(e.target.checked)} />
                  <span>{t("book:person.takeBiography")}</span>
                </label>
                <label>
                  <input type="checkbox" checked={takePhoto} onChange={(e) => setTakePhoto(e.target.checked)} />
                  <span>{t("book:person.takePhoto")}</span>
                </label>
              </div>

              <div className="metadata-link-row">
                <label className="search-field metadata-link-field">
                  <Link2 size={16} aria-hidden="true" />
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleLookupLink(); }}
                    placeholder={t("book:person.pasteLink")}
                    aria-label={t("book:person.profileLinkAria")}
                  />
                </label>
                <Button
                  variant="secondary"
                  className="metadata-search-button"
                  onClick={() => void handleLookupLink()}
                  disabled={lookingUpLink || !linkUrl.trim()}
                >
                  <Link2 size={16} aria-hidden="true" />
                  <span>{lookingUpLink ? t("book:person.reading") : t("book:metadata.fetch")}</span>
                </Button>
                <small className="metadata-link-hint">{t("book:person.linkHint")}</small>
              </div>

              {/* The running tally counts the FORM against what is saved, so
                  applying a second result can't make the first look undone. */}
              {stagedCount > 0 && (
                <p className="person-find-staged">
                  <Trans i18nKey="person.stagedReady" ns="book" count={stagedCount} components={{ bold: <strong /> }} />
                </p>
              )}

              <div className="metadata-results">
                {candidates.map((entry) => {
                  const isExpanded = entry.id === expandedId;
                  const thumbUrl = entry.photoUrl && !brokenPhotos.includes(entry.photoUrl) ? entry.photoUrl : null;
                  const lifeLine = [
                    formatLifespan(entry.facts.birthDate, entry.facts.deathDate),
                    entry.facts.country,
                    sourceLabel(entry.source)
                  ].filter(Boolean).join(" · ");
                  return (
                    <article className="metadata-result-card" key={entry.id}>
                      <div className="metadata-result-cover" aria-hidden="true">
                        {thumbUrl
                          ? <img src={thumbUrl} alt="" onError={() => markPhotoBroken(thumbUrl)} />
                          : entry.source === "openlibrary" ? <BookMarked size={22} /> : <Globe size={22} />}
                      </div>
                      <div className="metadata-result-body">
                        <div className="metadata-result-title-row">
                          <strong>{entry.title}</strong>
                        </div>
                        <span>{entry.facts.occupation ?? entry.description ?? t("book:person.noBioOnPage")}</span>
                        <small>{lifeLine}</small>
                        {entry.bio && <p>{entry.bio}</p>}
                      </div>
                      <div className="metadata-result-actions">
                        <Button
                          variant="primary"
                          compact
                          className="metadata-apply-button"
                          onClick={() => applyCandidate(entry)}
                          disabled={!takeFacts && !takeBio && !takePhoto}
                        >
                          {appliedId === entry.id
                            ? <Check size={15} aria-hidden="true" />
                            : <CheckCircle2 size={15} aria-hidden="true" />}
                          <span>{appliedId === entry.id ? t("book:person.addedToForm") : t("book:metadata.apply")}</span>
                        </Button>
                        <Button
                          variant="secondary"
                          compact
                          className="metadata-details-button"
                          onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                          <span>{t("book:metadata.details")}</span>
                        </Button>
                        {entry.sourceUrl && (
                          <a className="person-result-source-link" href={entry.sourceUrl} target="_blank" rel="noreferrer">
                            <ExternalLink size={14} aria-hidden="true" />
                            <span>{t("book:person.visitSource")}</span>
                          </a>
                        )}
                      </div>
                      {isExpanded && (
                        <PersonResultCompare
                          candidate={entry}
                          currentPhotoUrl={profile?.photoUrl ?? null}
                          current={{ birthDate, deathDate, country, occupation, bio }}
                          onPhotoError={markPhotoBroken}
                          brokenPhotos={brokenPhotos}
                        />
                      )}
                    </article>
                  );
                })}
                {candidates.length === 0 && (
                  <p className="management-empty">
                    {finding ? t("book:person.searching")
                      : searched ? t("book:person.lookupEmpty")
                      : t("book:person.lookupIdle")}
                  </p>
                )}
              </div>
            </>
          )}


        </div>

        <div className="metadata-actions person-edit-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy || !name.trim()}>
            <Save size={16} aria-hidden="true" />
            <span>{saving ? t("book:person.saving") : t("book:person.saveChanges")}</span>
          </Button>
        </div>
      </Modal>

      {photoBoxOpen && (
        <PersonPhotoModal
          personName={personName}
          currentPhotoUrl={photoUrl}
          onPhotoChanged={(url) => {
            setPhotoUrl(url);
            setPendingPhotoUrl(null); // the box wrote it already
            setProfile((prev) => prev ? { ...prev, photoUrl: url } : prev);
          }}
          onClose={() => setPhotoBoxOpen(false)}
        />
      )}

      {removeOpen && (
        <ConfirmDialog
          title={t("book:person.removePhotoConfirmTitle", { name: personName })}
          confirmLabel={t("book:person.removePhoto")}
          busy={removing}
          danger
          onConfirm={() => void removePhoto()}
          onCancel={() => setRemoveOpen(false)}
        >
          {t("book:person.removePhotoBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
