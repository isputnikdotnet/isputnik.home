import { screen, within } from "@testing-library/react";
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

const { api } = await import("../src/api");
const { CatalogPage } = await import("../src/features/audiobooks/catalog/CatalogPage");

// Audiobooks and Ebooks are one page (catalog/CatalogPage) drawn for two kinds.
// What differs is declared in catalogKinds.ts; these check each kind still gets
// its own words, endpoints, tiles and selection rules.

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

function mockCatalog(kind: "audiobooks" | "ebooks", lib = library()) {
  const calls: string[] = [];
  vi.mocked(api).mockImplementation(async (path: string) => {
    calls.push(path);
    if (path === `/api/library/${kind === "audiobooks" ? "audiobook" : "ebook"}-libraries`) return { libraries: [lib] } as never;
    if (path.startsWith(`/api/library/${kind}/facets`)) return FACETS as never;
    if (path === `/api/library/${kind}/catalog`) {
      return { books: [kind === "ebooks" ? book("e1", "Treasure Island", { format: "epub", documentId: "d1", formats: ["epub"] }) : book("b1", "Treasure Island")], total: 1 } as never;
    }
    if (path === "/api/library/categories") return { categories: [] } as never;
    return {} as never;
  });
  return calls;
}

beforeEach(() => { vi.mocked(api).mockReset(); });

describe("CatalogPage", () => {
  it("draws the audiobooks catalog from the audiobook endpoints", async () => {
    const calls = mockCatalog("audiobooks");
    renderSignedIn(<CatalogPage kind="audiobook" />);
    expect(await screen.findByRole("heading", { name: "Audiobooks" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Play Treasure Island/ })).toBeInTheDocument();
    // Narrators are an audiobook credit, so the subtitle counts them.
    expect(screen.getByText(/1 narrator/)).toBeInTheDocument();
    expect(calls).toContain("/api/library/audiobooks/catalog");
    expect(calls.some((path) => path.startsWith("/api/library/ebooks"))).toBe(false);
  });

  it("draws the ebooks catalog from the ebook endpoints", async () => {
    const calls = mockCatalog("ebooks");
    renderSignedIn(<CatalogPage kind="ebook" />);
    expect(await screen.findByRole("heading", { name: "Ebooks" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Read Treasure Island/ })).toBeInTheDocument();
    expect(screen.queryByText(/narrator/)).not.toBeInTheDocument();
    expect(calls).toContain("/api/library/ebooks/catalog");
    expect(calls.some((path) => path.startsWith("/api/library/audiobooks"))).toBe(false);
  });

  it("offers ebook selection to someone who may only delete, but not audiobook selection", async () => {
    const deleteOnly = library({ canWrite: false, canDelete: true });
    mockCatalog("ebooks", deleteOnly);
    const { unmount } = renderSignedIn(<CatalogPage kind="ebook" />);
    await screen.findByRole("button", { name: /Read Treasure Island/ });
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    unmount();

    mockCatalog("audiobooks", deleteOnly);
    renderSignedIn(<CatalogPage kind="audiobook" />);
    await screen.findByRole("button", { name: /Play Treasure Island/ });
    expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
  });

  it("selects books and opens the bulk delete question", async () => {
    const user = userEvent.setup();
    mockCatalog("audiobooks");
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
