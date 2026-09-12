import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const { api } = await import("../src/api");
const { CatalogPage } = await import("../src/features/audiobooks/catalog/CatalogPage");
const { writeCatalogView } = await import("../src/features/audiobooks/useAudiobookCatalog");
const { EMPTY_FILTERS } = await import("../src/features/audiobooks/BookFilter");

// Audiobooks and Ebooks are one page (catalog/CatalogPage) drawn for two kinds.
// What the KIND changes is declared in catalogKinds.ts — endpoints, words, tiles.
// How the page behaves is the same for both, and the second half of this file
// runs each behaviour on both kinds so a per-kind difference can't creep back in.

const book = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, libraryId: "lib", title, authors: ["Robert Louis Stevenson"], narrators: [], coverUrl: null,
  durationSeconds: 3480, seriesPosition: null, editionCount: 1, saved: false, progress: null,
  discoveredAt: "2020-01-01T00:00:00Z", totalSize: 1024, fileCount: 3,
  ...over
});

const library = (over: Record<string, unknown> = {}) => ({
  id: "lib", name: "Books", canWrite: true, canDownload: true, canDelete: true, canUpload: false,
  uploadExtensions: [], maxUploadMB: null, bookCount: 1, scanStatus: "idle", ...over
});

const FACETS = { authors: ["Robert Louis Stevenson"], narrators: ["Reader"], categories: [], tags: [], series: [], languages: [], letters: ["T"] };

type Kind = "audiobook" | "ebook";
const plural = (kind: Kind) => (kind === "audiobook" ? "audiobooks" : "ebooks");
const librariesPath = (kind: Kind) => `/api/library/${kind}-libraries`;
// The tile's own button: Play on an audiobook, Read on an ebook.
const tileButton = (kind: Kind) => (kind === "audiobook" ? /Play Treasure Island/ : /Read Treasure Island/);
const KINDS: Kind[] = ["audiobook", "ebook"];

function mockCatalog(kind: Kind, { lib = library(), libraries }: { lib?: ReturnType<typeof library>; libraries?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  vi.mocked(api).mockImplementation(async (path: string) => {
    calls.push(path);
    if (path === librariesPath(kind)) return (libraries ? libraries() : { libraries: [lib] }) as never;
    if (path.startsWith(`/api/library/${plural(kind)}/facets`)) return FACETS as never;
    if (path === `/api/library/${plural(kind)}/catalog`) {
      return { books: [kind === "ebook" ? book("e1", "Treasure Island", { format: "epub", documentId: "d1", formats: ["epub"] }) : book("b1", "Treasure Island")], total: 1 } as never;
    }
    if (path === "/api/library/categories") return { categories: [] } as never;
    if (path === "/api/library/books/bulk-delete") return { deleted: 1, forbidden: 0, missing: 0, failed: 0 } as never;
    return {} as never;
  });
  return calls;
}

beforeEach(() => { vi.mocked(api).mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("CatalogPage", () => {
  it("draws the audiobooks catalog from the audiobook endpoints", async () => {
    const calls = mockCatalog("audiobook");
    renderSignedIn(<CatalogPage kind="audiobook" />);
    expect(await screen.findByRole("heading", { name: "Audiobooks" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Play Treasure Island/ })).toBeInTheDocument();
    // Narrators are an audiobook credit, so the subtitle counts them.
    expect(screen.getByText(/1 narrator/)).toBeInTheDocument();
    expect(calls).toContain("/api/library/audiobooks/catalog");
    expect(calls.some((path) => path.startsWith("/api/library/ebooks"))).toBe(false);
  });

  it("draws the ebooks catalog from the ebook endpoints", async () => {
    const calls = mockCatalog("ebook");
    renderSignedIn(<CatalogPage kind="ebook" />);
    expect(await screen.findByRole("heading", { name: "Ebooks" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Read Treasure Island/ })).toBeInTheDocument();
    expect(screen.queryByText(/narrator/)).not.toBeInTheDocument();
    expect(calls).toContain("/api/library/ebooks/catalog");
    expect(calls.some((path) => path.startsWith("/api/library/audiobooks"))).toBe(false);
  });

  it("selects books and opens the bulk delete question", async () => {
    const user = userEvent.setup();
    mockCatalog("audiobook");
    renderSignedIn(<CatalogPage kind="audiobook" />);
    await screen.findByRole("button", { name: /Play Treasure Island/ });
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: /Select Treasure Island/ }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByTitle(/Move the selected books to the Recycle Bin/));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Move 1 book" })).toBeInTheDocument();
  });
});

describe.each(KINDS)("CatalogPage behaves the same for %s", (kind) => {
  it("offers selection to someone who may only delete, with Delete as its one action", async () => {
    const user = userEvent.setup();
    mockCatalog(kind, { lib: library({ canWrite: false, canDelete: true }) });
    renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit/ })).not.toBeInTheDocument();
  });

  it("offers no selection to someone who may neither edit nor delete", async () => {
    mockCatalog(kind, { lib: library({ canWrite: false, canDelete: false }) });
    renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
  });

  it("waits for the library list before saying there are none", async () => {
    let release: (value: unknown) => void = () => {};
    mockCatalog(kind, { libraries: () => new Promise((resolve) => { release = resolve; }) });
    renderSignedIn(<CatalogPage kind={kind} />);
    const noLibraries = kind === "audiobook" ? "No audiobook libraries yet" : "No ebook libraries yet";
    await screen.findByRole("heading", { name: kind === "audiobook" ? "Audiobooks" : "Ebooks" });
    expect(screen.queryByText(noLibraries)).not.toBeInTheDocument();
    await act(async () => { release({ libraries: [] }); });
    expect(await screen.findByText(noLibraries)).toBeInTheDocument();
  });

  it("re-reads the library counts after a delete", async () => {
    const user = userEvent.setup();
    const calls = mockCatalog(kind);
    renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    const before = calls.filter((path) => path === librariesPath(kind)).length;
    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: /Select Treasure Island/ }));
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Move 1/ }));
    await waitFor(() => expect(calls.filter((path) => path === librariesPath(kind)).length).toBeGreaterThan(before));
  });

  it("says so when a scan poll of the library list fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let first = true;
    mockCatalog(kind, {
      libraries: async () => {
        if (first) { first = false; return { libraries: [library({ scanStatus: "scanning" })] }; }
        throw new Error("The server went away");
      }
    });
    renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    expect(screen.queryByText("The server went away")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText("The server went away")).toBeInTheDocument();
  });

  // Last: the chosen order is remembered for the session, which is exactly the
  // state this would leak into a test that came after it.
  it("opens on Recently added, and remembers the order chosen for the next visit", async () => {
    const user = userEvent.setup();
    const sortName = kind === "audiobook" ? /^Sort audiobooks:/ : /^Sort ebooks:/;
    mockCatalog(kind);
    const { unmount } = renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    const trigger = screen.getByRole("button", { name: sortName });
    expect(trigger).toHaveAccessibleName(expect.stringContaining("Recently added"));
    await user.click(trigger);
    await user.click(screen.getByRole("menuitemradio", { name: "Title (A–Z)" }));
    unmount();

    renderSignedIn(<CatalogPage kind={kind} />);
    await screen.findByRole("button", { name: tileButton(kind) });
    expect(screen.getByRole("button", { name: sortName })).toHaveAccessibleName(expect.stringContaining("Title (A–Z)"));
  });
});

// Choosing libraries is a filter facet, and one library in the filter IS the scope
// the catalog, the facets and the A–Z letters are asked for. That decision is
// derived inside useMediaCatalog, next to the filters it is made from — the page
// used to keep a copy of it and set it from an effect, so the very first render
// asked for "all", and the remembered single-library view cost an extra render and
// a wasted pair of requests on every mount.
describe("CatalogPage library scope", () => {

  // The session view is module state; put it back so the tests above stay honest
  // whichever order they run in.
  afterEach(() => { writeCatalogView("audiobooks:main", { filters: EMPTY_FILTERS }); });

  it("asks for the remembered single library on the FIRST request, not the second", async () => {
    writeCatalogView("audiobooks:main", { filters: { ...EMPTY_FILTERS, libraries: ["lib"] } });
    const scopes: unknown[] = [];
    const facetScopes: string[] = [];
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === librariesPath("audiobook")) return { libraries: [library()] } as never;
      if (path.startsWith("/api/library/audiobooks/facets")) { facetScopes.push(path); return FACETS as never; }
      if (path === "/api/library/audiobooks/catalog") {
        scopes.push(JSON.parse(String(init?.body)));
        return { books: [book("b1", "Treasure Island")], total: 1 } as never;
      }
      if (path === "/api/library/categories") return { categories: [] } as never;
      return {} as never;
    });

    renderSignedIn(<CatalogPage kind="audiobook" />);
    await screen.findByRole("button", { name: /Play Treasure Island/ });

    expect(scopes).not.toHaveLength(0);
    expect(scopes[0]).toMatchObject({ scope: "library", libraryId: "lib" });
    // No round trip against the whole catalog on the way there.
    expect(scopes.some((body) => (body as { scope: string }).scope === "all")).toBe(false);
    expect(facetScopes.every((path) => path.includes("scope=library"))).toBe(true);
  });

  it("asks for the whole catalog when the filter names several libraries", async () => {
    writeCatalogView("audiobooks:main", { filters: { ...EMPTY_FILTERS, libraries: ["lib", "lib2"] } });
    const scopes: unknown[] = [];
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === librariesPath("audiobook")) return { libraries: [library()] } as never;
      if (path.startsWith("/api/library/audiobooks/facets")) return FACETS as never;
      if (path === "/api/library/audiobooks/catalog") {
        scopes.push(JSON.parse(String(init?.body)));
        return { books: [book("b1", "Treasure Island")], total: 1 } as never;
      }
      if (path === "/api/library/categories") return { categories: [] } as never;
      return {} as never;
    });

    renderSignedIn(<CatalogPage kind="audiobook" />);
    await screen.findByRole("button", { name: /Play Treasure Island/ });
    expect(scopes[0]).toMatchObject({ scope: "all" });
  });
});
