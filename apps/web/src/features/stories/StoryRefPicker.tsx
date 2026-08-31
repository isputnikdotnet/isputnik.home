import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Images, Play, Quote, Search, UserRound } from "lucide-react";
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
export type RefKind = "album" | "slideshow" | "person" | "quote";

interface Row {
  id: string;
  title: string;
  /** Ready-made second line (a person's life years, a quote's speaker). */
  detail: string;
  /** Photo count, when the second line is a count the component pluralizes. */
  count?: number;
  coverUrl: string | null;
}

const ICONS: Record<RefKind, typeof Images> = {
  album: Images,
  slideshow: Play,
  person: UserRound,
  quote: Quote
};

export function StoryRefPicker({
  kind,
  onPick,
  onClose
}: {
  kind: RefKind;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
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
  const visible = (rows ?? []).filter((row) =>
    !term || row.title.toLowerCase().includes(term) || row.detail.toLowerCase().includes(term));

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

        {rows === null && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {rows && visible.length === 0 && (
          <p className="management-empty">
            {rows.length === 0 ? t(`stories:picker.${kind}Empty`) : t("stories:picker.noMatches")}
          </p>
        )}

        <div className="story-picker-list">
          {visible.map((row) => (
            <button type="button" className="story-picker-row" key={row.id} onClick={() => onPick(row.id)}>
              <span className="story-picker-cover" aria-hidden="true">
                {row.coverUrl ? <img src={row.coverUrl} alt="" /> : <Icon size={18} />}
              </span>
              <span className="story-picker-text">
                <strong>{row.title}</strong>
                {(row.count != null || row.detail) && (
                  <small>{row.count != null ? t("stories:count.photos", { count: row.count }) : row.detail}</small>
                )}
              </span>
            </button>
          ))}
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
      albums?: { id: string; name: string; itemCount: number; coverUrl: string | null }[];
      slideshows?: { id: string; name: string; itemCount: number; coverUrl: string | null }[];
    }>(kind === "album" ? "/api/library/gallery/albums" : "/api/library/gallery/slideshows");
    return (payload.albums ?? payload.slideshows ?? []).map((row) => ({
      id: row.id,
      title: row.name,
      detail: "",
      count: row.itemCount,
      coverUrl: row.coverUrl
    }));
  }

  if (kind === "person") {
    const payload = await api<{ persons: FamilyPerson[] }>("/api/family-tree/persons");
    return payload.persons.map((person) => ({
      id: person.id,
      title: person.name,
      detail: lifeYears(person),
      coverUrl: person.portraitUrl
    }));
  }

  const payload = await api<{ quotes: QuoteRecord[] }>("/api/library/quotes?limit=200");
  return payload.quotes.map((quote) => ({
    id: quote.id,
    // A quote can run to several lines; a picker row is one.
    title: quote.text.replace(/\s+/g, " ").trim(),
    detail: quote.personName ?? quote.sourceAuthors[0] ?? quote.sourceTitle ?? "",
    coverUrl: null
  }));
}
