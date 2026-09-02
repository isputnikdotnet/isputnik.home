import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Images, Play, Quote, Search, UserRound } from "lucide-react";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import { lifeYears, type FamilyPerson } from "../familytree/types";
// Aliased: `Quote` is already the lucide icon in this file.
import type { Quote as QuoteRecord } from "../audiobooks/types";

// Choose the thing a reference block points at. One searchable list over four
// endpoints, because it is the same choice every time — only the source and the
// line under each row differ. Photos and videos keep their own door
// (PhotoPicker), which is a grid rather than a list.
export type RefKind = "album" | "slideshow" | "person" | "quote" | "book";

interface Row {
  id: string;
  title: string;
  /** The row's own tags — what a suggestion is matched on. */
  tags: string[];
  /** Ready-made second line (a person's life years, a quote's speaker). */
  detail: string;
  /** Photo count, when the second line is a count the component pluralizes. */
  count?: number;
  coverUrl: string | null;
  /** Book rows only: which book type this is — handed back through onPick. */
  entityType?: "audiobook" | "ebook";
}

const ICONS: Record<RefKind, typeof Images> = {
  album: Images,
  slideshow: Play,
  person: UserRound,
  quote: Quote,
  book: BookOpen
};

export function StoryRefPicker({
  kind,
  storyTags = [],
  onPick,
  onClose
}: {
  kind: RefKind;
  /** The story's own tags. Anything sharing one is offered first. */
  storyTags?: string[];
  /** Book picks also say which book type was chosen, and every pick carries
   *  its row's title for callers that display or reuse it. */
  onPick: (
    id: string,
    entityType?: "audiobook" | "ebook",
    title?: string,
    /** The artwork the row was showing — a review can wear its book's cover. */
    coverUrl?: string | null
  ) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  // Books come from two shelves. The list holds both, and this narrows it —
  // the type is part of the choice (a review of the audiobook is not a review
  // of the ebook), so it can't just be inferred from the title.
  const [bookType, setBookType] = useState<"all" | "audiobook" | "ebook">("all");
  const Icon = ICONS[kind];

  useEffect(() => {
    let alive = true;
    loadRows(kind)
      .then((loaded) => { if (alive) setRows(loaded); })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : t("stories:errors.load"));
      });
    return () => { alive = false; };
  }, [kind]);

  const term = search.trim().toLowerCase();
  const visible = (rows ?? [])
    .filter((row) => bookType === "all" || row.entityType === bookType)
    .filter((row) => !term || row.title.toLowerCase().includes(term) || row.detail.toLowerCase().includes(term));

  // Anything sharing a tag with the story is almost certainly what the author
  // is reaching for, so it goes first under its own heading. Searching drops
  // the split — a search IS the intent, and two lists would just hide matches.
  const wanted = new Set(storyTags.map((tag) => tag.toLowerCase()));
  const suggested = term || wanted.size === 0
    ? []
    : visible.filter((row) => row.tags.some((tag) => wanted.has(tag.toLowerCase())));
  const suggestedIds = new Set(suggested.map((row) => row.id));
  const rest = visible.filter((row) => !suggestedIds.has(row.id));

  const renderRow = (row: Row) => (
    <button type="button" className="story-picker-row" key={`${row.entityType ?? kind}:${row.id}`} onClick={() => onPick(row.id, row.entityType, row.title, row.coverUrl)}>
      <span className="story-picker-cover" aria-hidden="true">
        {row.coverUrl ? <img src={row.coverUrl} alt="" /> : <Icon size={18} />}
      </span>
      <span className="story-picker-text">
        <strong>{row.title}</strong>
        {(row.count != null || row.detail) && (
          <small>{row.count != null ? t("stories:count.photos", { count: row.count }) : row.detail}</small>
        )}
      </span>
      {/* Which shelf this row came from — the same title can sit on both. */}
      {row.entityType && (
        <span className="story-picker-type">{t(`common:mediaKind.${row.entityType}`)}</span>
      )}
    </button>
  );

  return (
    <Modal
      variant="panel"
      title={t(`stories:picker.${kind}Title`)}
      icon={<Icon size={20} />}
      onClose={onClose}
    >
      <div className="modal-tab-content story-set-picker">
        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}

        <label className="field story-picker-search">
          <span className="sr-only">{t("stories:picker.search")}</span>
          <Search size={15} aria-hidden="true" />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("stories:picker.search")}
          />
        </label>

        {kind === "book" && (
          <div className="modal-tabs">
            {([
              ["all", t("stories:picker.bookAll")],
              ["audiobook", t("stories:picker.bookAudiobooks")],
              ["ebook", t("stories:picker.bookEbooks")]
            ] as ["all" | "audiobook" | "ebook", string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`modal-tab${bookType === key ? " active" : ""}`}
                onClick={() => setBookType(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {rows === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {rows && visible.length === 0 && (
          <p className="management-empty">
            {rows.length === 0 ? t(`stories:picker.${kind}Empty`) : t("stories:picker.noMatches")}
          </p>
        )}

        <div className="story-picker-list">
          {suggested.length > 0 && (
            <>
              <p className="story-picker-group">{t("stories:picker.suggested")}</p>
              {suggested.map(renderRow)}
              {rest.length > 0 && <p className="story-picker-group">{t("stories:picker.everything")}</p>}
            </>
          )}
          {rest.map(renderRow)}
        </div>
      </div>
    </Modal>
  );
}

// Each source flattened to the same row shape, so the list above stays one list.
// No translator here: a count is handed back as a number and pluralized by the
// component, which is the only place that should be reading strings.
async function loadRows(kind: RefKind): Promise<Row[]> {
  if (kind === "album" || kind === "slideshow") {
    const payload = await api<{
      albums?: { id: string; name: string; itemCount: number; coverUrl: string | null; tags: string[] }[];
      slideshows?: { id: string; name: string; itemCount: number; coverUrl: string | null; tags: string[] }[];
    }>(kind === "album" ? "/api/library/gallery/albums" : "/api/library/gallery/slideshows");
    return (payload.albums ?? payload.slideshows ?? []).map((row) => ({
      id: row.id,
      title: row.name,
      detail: "",
      count: row.itemCount,
      coverUrl: row.coverUrl,
      tags: row.tags ?? []
    }));
  }

  if (kind === "person") {
    const payload = await api<{ persons: FamilyPerson[] }>("/api/family-tree/persons");
    return payload.persons.map((person) => ({
      id: person.id,
      title: person.name,
      detail: lifeYears(person),
      coverUrl: person.portraitUrl,
      tags: person.tags
    }));
  }

  if (kind === "book") {
    // Both shelves in one list — a story doesn't care which kind of book it
    // mentions, but the block records it (the reference's entity type).
    type CatalogBook = { id: string; title: string; authors: string[]; coverUrl: string | null; tags: string[] };
    const load = (url: string) =>
      api<{ books: CatalogBook[] }>(url, { method: "POST", body: JSON.stringify({ limit: 200 }) })
        .catch(() => ({ books: [] as CatalogBook[] }));
    const [audiobooks, ebooks] = await Promise.all([
      load("/api/library/audiobooks/catalog"),
      load("/api/library/ebooks/catalog")
    ]);
    const toRow = (entityType: "audiobook" | "ebook") => (book: CatalogBook): Row => ({
      id: book.id,
      title: book.title,
      detail: book.authors.join(", "),
      coverUrl: book.coverUrl,
      tags: book.tags ?? [],
      entityType
    });
    return [
      ...audiobooks.books.map(toRow("audiobook")),
      ...ebooks.books.map(toRow("ebook"))
    ].sort((a, b) => a.title.localeCompare(b.title));
  }

  const payload = await api<{ quotes: QuoteRecord[] }>("/api/library/quotes?limit=200");
  return payload.quotes.map((quote) => ({
    id: quote.id,
    // A quote can run to several lines; a picker row is one.
    title: quote.text.replace(/\s+/g, " ").trim(),
    detail: quote.personName ?? quote.sourceAuthors[0] ?? quote.sourceTitle ?? "",
    coverUrl: null,
    tags: quote.tags
  }));
}
