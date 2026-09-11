import type { AudiobookBook } from "../types";
import type { BookFilters } from "../BookFilter";
import type { CatalogEndpoints } from "../useAudiobookCatalog";

// The Audiobooks and Ebooks pages are one page (CatalogPage) over two kinds of
// library. Everything that differs between them — endpoints, the words, which
// facets and actions apply — is declared here, once per kind.
export type CatalogKind = "audiobook" | "ebook";

// What the page needs to know about a library, whichever kind it is.
export interface CatalogLibrary {
  id: string;
  name: string;
  canWrite: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canUpload: boolean;
  uploadExtensions: string[];
  maxUploadMB: number | null;
  bookCount: number;
  scanStatus: "idle" | "scanning" | "error";
}

// The shared book shape plus the primary document's format/id (for the Read button
// and the direct download link) and the full list of available formats (for the
// format chips) — what /api/library/ebooks/catalog returns.
export type EbookBook = AudiobookBook & { format?: string | null; documentId?: string | null; formats?: string[] };

// Ebooks only expose the facets that apply — no narrators/series/length.
const EBOOK_FILTER_FIELDS: (keyof BookFilters)[] = ["libraries", "status", "authors", "categories", "tags", "languages"];

const AUDIOBOOK = {
  dashboard: "audiobooks",
  persistKey: "audiobooks:main",
  endpoints: { catalog: "/api/library/audiobooks/catalog", facets: "/api/library/audiobooks/facets" } as CatalogEndpoints,
  /** /api/library/<this> lists the libraries; /<this>/:id/series holds their series. */
  librariesPath: "audiobook-libraries",
  /** Facets the Filter panel offers — every one. */
  filterFields: undefined as (keyof BookFilters)[] | undefined,
  /** Narrators are an audiobook credit: counted, suggested and bulk-edited here only. */
  narrators: true,
  /** The sort starts at "Recently added" on every visit rather than the last one chosen. */
  rememberSort: false,
  /** Wait for the library list before deciding there are no libraries. */
  emptyStateAfterLoad: false,
  /** Selection is offered to someone who may delete but not edit. */
  selectToDelete: false,
  /** Re-read the library list (book counts) after an upload or a delete. */
  refreshLibrariesAfterChange: false,
  /** A failed scan-poll of the library list stays quiet instead of showing an error. */
  quietPoll: true,
  keys: {
    title: "book:catalog.audiobooksTitle",
    searchPlaceholder: "book:catalog.searchAudiobooksPlaceholder",
    errorTitle: "book:catalog.audiobooksErrorTitle",
    unableLoadLibraries: "book:catalog.unableLoadLibraries",
    noLibraries: "book:catalog.noAudiobookLibraries",
    createLibraryHint: "book:catalog.createLibraryHintAudiobooks",
    adminAddLibraries: "book:catalog.adminAddLibraries",
    browseAria: "book:catalog.browseAudiobooksAria",
    sortAria: "book:catalog.sortAudiobooksAria",
    selectAllLoaded: "book:catalog.selectAllLoadedAudiobooks",
    groupSelected: "book:catalog.groupSelectedAudiobooksTitle",
    deleteSelected: "book:catalog.deleteSelectedAudiobooksTitle",
    letterAria: "book:catalog.filterAudiobooksByLetterAria",
    scanningTitle: "book:catalog.scanningAudiobooksTitle",
    emptyNoneInLibrary: "book:catalog.emptyNoneInLibraryAudiobooks",
    emptyNoMatch: "book:catalog.emptyNoMatchAudiobooks",
    emptyNone: "book:catalog.emptyNoneAudiobooks",
    updatedNotice: "book:catalog.updatedBooksNotice",
    movedToRecycleNotice: "book:catalog.movedToRecycleNotice",
    unableMoveOne: "book:catalog.unableMoveAudiobookToRecycle",
    unableMoveSelected: "book:catalog.unableMoveSelectedAudiobooksToRecycle",
    bulkDeleteTitle: "book:catalog.bulkDeleteTitleAudiobooks",
    bulkDeleteButton: "book:catalog.bulkDeleteButtonAudiobooks",
    bulkDeleteBody: "book:catalog.bulkDeleteBodyAudiobooks"
  }
} as const;

const EBOOK = {
  dashboard: "ebooks",
  persistKey: "ebooks:main",
  endpoints: { catalog: "/api/library/ebooks/catalog", facets: "/api/library/ebooks/facets" } as CatalogEndpoints,
  librariesPath: "ebook-libraries",
  filterFields: EBOOK_FILTER_FIELDS as (keyof BookFilters)[] | undefined,
  narrators: false,
  rememberSort: true,
  emptyStateAfterLoad: true,
  selectToDelete: true,
  refreshLibrariesAfterChange: true,
  quietPoll: false,
  keys: {
    title: "book:catalog.ebooksTitle",
    searchPlaceholder: "book:catalog.searchEbooksPlaceholder",
    errorTitle: "book:catalog.ebooksErrorTitle",
    unableLoadLibraries: "book:catalog.unableLoadEbookLibraries",
    noLibraries: "book:catalog.noEbookLibraries",
    createLibraryHint: "book:catalog.createLibraryHintEbooks",
    adminAddLibraries: "book:catalog.adminAddEbookLibrary",
    browseAria: "book:catalog.browseEbooksAria",
    sortAria: "book:catalog.sortEbooksAria",
    selectAllLoaded: "book:catalog.selectAllLoadedEbooks",
    groupSelected: "book:catalog.groupSelectedEbooksTitle",
    deleteSelected: "book:catalog.deleteSelectedEbooksTitle",
    letterAria: "book:catalog.filterEbooksByLetterAria",
    scanningTitle: "book:catalog.scanningEbooksTitle",
    emptyNoneInLibrary: "book:catalog.emptyNoneInLibraryEbooks",
    emptyNoMatch: "book:catalog.emptyNoMatchEbooks",
    emptyNone: "book:catalog.emptyNoneEbooks",
    updatedNotice: "book:catalog.updatedEbooksNotice",
    movedToRecycleNotice: "book:catalog.movedEbooksToRecycleNotice",
    unableMoveOne: "book:catalog.unableMoveEbookToRecycle",
    unableMoveSelected: "book:catalog.unableMoveSelectedEbooksToRecycle",
    bulkDeleteTitle: "book:catalog.bulkDeleteTitleEbooks",
    bulkDeleteButton: "book:catalog.bulkDeleteButtonEbooks",
    bulkDeleteBody: "book:catalog.bulkDeleteBodyEbooks"
  }
} as const;

export const CATALOG_KINDS = { audiobook: AUDIOBOOK, ebook: EBOOK };

export type CatalogKindConfig = (typeof CATALOG_KINDS)[CatalogKind];
