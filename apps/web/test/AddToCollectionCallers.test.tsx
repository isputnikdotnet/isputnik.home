import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
vi.mock("../src/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/router")>();
  return { ...actual, navigate: vi.fn() };
});

const { api } = await import("../src/api");
const { CatalogPage } = await import("../src/features/audiobooks/catalog/CatalogPage");
const { GalleryLightbox } = await import("../src/features/gallery/GalleryLightbox");
const { GalleryPage } = await import("../src/features/gallery/GalleryPage");
const { QuotesPage } = await import("../src/features/library/QuotesPage");
const { AudiobookBookPage } = await import("../src/features/audiobooks/BookDetailPage");
const mockApi = vi.mocked(api);

// AddToCollectionModal.test.tsx pins what each call site PASSES, from the source.
// These go one step further for every surface that can be mounted: open the
// real page, add the thing on screen to a collection, and read the entityType
// off the request that would reach the server. The server stores whatever type
// it is told and later hydrates by libraries.type, so a wrong one here is an
// item that silently vanishes from the collection.

type Call = { path: string; method: string; body: unknown };

/** Answers the collection requests; everything else goes to the page's own handler. */
function serve(page: (path: string) => unknown) {
  const calls: Call[] = [];
  mockApi.mockImplementation(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    if (method === "GET" && path.startsWith("/api/collections?")) {
      return {
        collections: [{ id: "c1", name: "Keepsakes", description: null, itemCount: 0, coverUrls: [], createdAt: "", updatedAt: "" }]
      } as never;
    }
    if (method === "POST" && /^\/api\/collections\/c1\/items(\/batch)?$/.test(path)) return { added: 1, skipped: 0 } as never;
    return page(path) as never;
  });
  return calls;
}

async function addToKeepsakes() {
  const dialog = within(await screen.findByRole("dialog", { name: "Add to collection" }));
  await userEvent.click(await dialog.findByText("Keepsakes"));
}

const collectionPost = (calls: Call[]) =>
  calls.find((c) => c.method === "POST" && c.path.startsWith("/api/collections/c1/items"));

beforeEach(() => {
  mockApi.mockReset();
});

// ── Catalog (Audiobooks / Ebooks browse) ──

const book = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, libraryId: "lib", title, authors: ["Robert Louis Stevenson"], narrators: [], coverUrl: null,
  durationSeconds: 3480, seriesPosition: null, editionCount: 1, saved: false, progress: null,
  discoveredAt: "2020-01-01T00:00:00Z", totalSize: 1024, fileCount: 3,
  ...over
});
const catalogLibrary = {
  id: "lib", name: "Books", canWrite: true, canDownload: true, canDelete: true, canUpload: false,
  uploadExtensions: [], maxUploadMB: null, bookCount: 1, scanStatus: "idle"
};

function catalog(kind: "audiobooks" | "ebooks") {
  return serve((path) => {
    if (path === `/api/library/${kind === "audiobooks" ? "audiobook" : "ebook"}-libraries`) return { libraries: [catalogLibrary] };
    if (path.startsWith(`/api/library/${kind}/facets`)) {
      return { authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], letters: ["T"] };
    }
    if (path === `/api/library/${kind}/catalog`) {
      const row = kind === "ebooks"
        ? book("e1", "Treasure Island", { format: "epub", documentId: "d1", formats: ["epub"] })
        : book("b1", "Treasure Island");
      return { books: [row], total: 1 };
    }
    if (path === "/api/library/categories") return { categories: [] };
    return {};
  });
}

describe("CatalogPage", () => {
  it("adds an audiobook from the Audiobooks catalog as an audiobook", async () => {
    const calls = catalog("audiobooks");
    renderSignedIn(<CatalogPage kind="audiobook" />);
    await screen.findByRole("button", { name: /Play Treasure Island/ });
    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    await addToKeepsakes();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "audiobook", entityId: "b1" }));
    expect(calls.map((c) => c.path)).toContain("/api/collections?entityType=audiobook&entityId=b1");
  });

  it("adds an ebook from the Ebooks catalog as an ebook", async () => {
    const calls = catalog("ebooks");
    renderSignedIn(<CatalogPage kind="ebook" />);
    await screen.findByRole("button", { name: /Read Treasure Island/ });
    await userEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    await addToKeepsakes();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "ebook", entityId: "e1" }));
  });
});

// ── Gallery ──

const asset = (id: string, over: Record<string, unknown> = {}) => ({
  id, libraryId: "lib", libraryName: "Photos", folderPath: `Trips/${id}.jpg`, folder: "Trips",
  kind: "photo", title: `${id}.jpg`, description: null,
  takenAt: "2019-07-04T10:00:00Z", takenPrecision: "day", takenApprox: false,
  placeText: null, reviewedAt: null, reviewedBy: null, addedAt: "2020-01-01T00:00:00Z",
  width: 100, height: 100, orientation: null, rotation: 0, durationSeconds: null, playable: null,
  coverUrl: `/api/library/covers/${id}`, previewUrl: `/api/library/covers/${id}`,
  fileUrl: `/api/library/gallery/assets/${id}/file`, playbackUrl: `/api/library/gallery/assets/${id}/file`,
  saved: false, tags: [], people: [],
  ...over
});

describe("GalleryLightbox", () => {
  it("adds the photo on screen as a gallery item", async () => {
    const calls = serve((path) => {
      if (path.endsWith("/people")) return { people: [] };
      if (/\/api\/library\/gallery\/assets\/[^/]+$/.test(path)) return { asset: asset("p1") };
      return {};
    });
    render(
      <GalleryLightbox
        assets={[asset("p1")] as never}
        index={0}
        canDelete={false}
        canEdit={false}
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    // A secondary action: it lives under the viewer's More menu.
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add to collection" }));
    await addToKeepsakes();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "gallery", entityId: "p1" }));
  });
});

describe("GalleryPage selection bar", () => {
  it("batch-adds the selected photos as gallery items", async () => {
    const library = {
      id: "lib", name: "Photos", bookCount: 2, inbox: false, role: null, scanStatus: "idle",
      canWrite: true, canDelete: true, canDownload: true, canUpload: false, canCurate: true,
      uploadExtensions: [], maxUploadMB: null
    };
    const calls = serve((path) => {
      if (path === "/api/library/gallery-libraries") return { libraries: [library] };
      if (path.startsWith("/api/library/gallery/year-review")) return { suggestions: [] };
      if (path.startsWith("/api/library/gallery/facets")) return { kinds: [], years: [], withGps: 0, people: [], tags: [], cameras: [] };
      if (path.startsWith("/api/library/gallery/memories")) return { suggestions: [], precision: "day", groups: [] };
      if (path === "/api/library/gallery/timeline") return { assets: [asset("a1"), asset("a2")], total: 2 };
      return {};
    });
    renderSignedIn(<GalleryPage view="timeline" />);
    await screen.findByRole("heading", { name: "July 4, 2019" });

    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    for (const id of ["a1", "a2"]) {
      await userEvent.click(screen.getByRole("button", { name: new RegExp(`${id}\\.jpg`) }));
    }
    await userEvent.click(screen.getByTitle("Add to collection"));
    await addToKeepsakes();
    await waitFor(() => expect(collectionPost(calls)).toBeDefined());
    expect(collectionPost(calls)).toEqual({
      path: "/api/collections/c1/items/batch",
      method: "POST",
      body: { entityType: "gallery", entityIds: expect.arrayContaining(["a1", "a2"]) }
    });
  });
});

// ── Quotes ──

describe("QuotesPage", () => {
  it("adds a quote as a quote", async () => {
    const quote = {
      id: "q1", itemId: null, documentId: null, cfi: null, text: "Measure twice, cut once.", note: null, color: null,
      percentComplete: null, origin: "manual", mine: true, ownerName: null, tags: [], personId: null, personName: "Grandpa",
      visibility: "family", inRotation: true, language: null, quoteDate: null, context: null, sourceTitle: null,
      sourceAuthors: [], libraryType: null, coverUrl: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
    };
    const calls = serve((path) => {
      if (path.startsWith("/api/library/quotes?")) return { quotes: [quote], total: 1, categories: [] };
      if (path === "/api/family-tree/persons") return { persons: [] };
      return {};
    });
    renderSignedIn(<QuotesPage />);
    await screen.findByText(/Measure twice, cut once\./);
    await userEvent.click(screen.getByRole("button", { name: "Add quote to a collection" }));
    await addToKeepsakes();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "quote", entityId: "q1" }));
  });
});

// ── Book detail ──
//
// One page for both routes, and the type is derived from the book's contents
// (BookDetailPage: isEbook = no audio files and at least one document), not
// from the route it was opened on.

const detail = (over: Record<string, unknown>) => ({
  id: "bk1", libraryId: "lib", folderPath: "Treasure Island", status: "ready", title: "Treasure Island",
  series: null, seriesPosition: null, authors: ["Robert Louis Stevenson"], narrators: [], category: null, tags: [],
  language: null, fileCount: 1, totalSize: 1024, editionCount: 1, durationSeconds: null, coverUrl: null,
  coverLargeUrl: null, publisher: null, asin: null, saved: false, discoveredAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:00:00Z", libraryName: "Books", progressMode: "linear", seriesId: null,
  description: null, yearPublished: null, isbn: null, openLibraryId: null, metadataSource: "scan", workId: null,
  files: [], documents: [],
  ...over
});

function bookPage(book: Record<string, unknown>) {
  return serve((path) => {
    if (path === "/api/library/books/bk1") {
      return { book, capabilities: { canEdit: false, canDelete: false, canDownload: false, canWrite: false } };
    }
    if (path.includes("/progress")) return { progress: null, tracks: [] };
    if (path.endsWith("/save")) return { save: null };
    if (path.includes("/bookmarks")) return { bookmarks: [] };
    if (path.includes("/quotes")) return { quotes: [], total: 0 };
    if (path.includes("/notes")) return { notes: [] };
    if (path.includes("/stories")) return { stories: [] };
    return {};
  });
}

async function addFromBookPage() {
  await userEvent.click(await screen.findByRole("button", { name: "Add to collection" }));
  await addToKeepsakes();
}

describe("BookDetailPage", () => {
  it("adds a book with audio as an audiobook", async () => {
    const calls = bookPage(detail({
      durationSeconds: 3600,
      files: [{ id: "f1", relativePath: "01.mp3", mimeType: "audio/mpeg", trackNumber: 1, chapterTitle: null, durationSeconds: 3600, size: 1024, modifiedAt: null, status: "available" }]
    }));
    renderSignedIn(<AudiobookBookPage id="bk1" />);
    await screen.findByRole("heading", { name: "Treasure Island" });
    await addFromBookPage();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "audiobook", entityId: "bk1" }));
  });

  it("adds a book with only a document, on the Ebooks route, as an ebook", async () => {
    const calls = bookPage(detail({
      documents: [{ id: "d1", fileName: "treasure.epub", format: "epub", mimeType: "application/epub+zip", size: 1024, url: "/api/library/books/bk1/documents/d1" }]
    }));
    renderSignedIn(<AudiobookBookPage id="bk1" active="ebooks" backTo="/ebooks" />);
    await screen.findByRole("heading", { name: "Treasure Island" });
    await addFromBookPage();
    await waitFor(() => expect(collectionPost(calls)?.body).toEqual({ entityType: "ebook", entityId: "bk1" }));
  });
});
