import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary } from "../src/features/collections/types";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { AddToCollectionModal } = await import("../src/features/collections/AddToCollectionModal");
const mockApi = vi.mocked(api);

// Collections are cross-type: one collection can hold audiobooks, ebooks, photos
// and quotes, told apart on the server by entity_type. The server's hydrator
// filters on libraries.type, so an ebook stored as "audiobook" silently turns
// into an unavailable row. What this dialog sends as entityType is therefore
// the whole contract, and these tests read it off every request.

type EntityType = "audiobook" | "ebook" | "gallery" | "quote";
type Call = { path: string; method: string; body: unknown };

const collection = (id: string, name: string, over: Partial<CollectionSummary> = {}): CollectionSummary => ({
  id,
  name,
  description: null,
  itemCount: 0,
  coverUrls: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over
});

function serve(collections: CollectionSummary[], over: { onPost?: (path: string, body: unknown) => unknown } = {}) {
  const calls: Call[] = [];
  mockApi.mockImplementation(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    if (method === "GET" && path.startsWith("/api/collections?")) return { collections } as never;
    if (method === "POST") {
      const custom = over.onPost?.(path, body);
      if (custom !== undefined) return custom as never;
      if (path === "/api/collections") return { collection: collection("created", (body as { name: string }).name) } as never;
      if (path.endsWith("/items/batch")) return { added: 2, skipped: 0 } as never;
      return {} as never;
    }
    if (method === "DELETE") return {} as never;
    throw new Error(`unexpected ${method} ${path}`);
  });
  return calls;
}

const dialog = () => within(screen.getByRole("dialog", { name: "Add to collection" }));
const row = (name: string) => dialog().getByRole("button", { name: new RegExp(`^${name}`) });
const gets = (calls: Call[]) => calls.filter((c) => c.method === "GET");
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

// A block body: a hook that RETURNS a function has it run as cleanup, and
// mockReset returns the mock — which then gets called with no arguments.
beforeEach(() => {
  mockApi.mockReset();
});

describe("AddToCollectionModal — one item", () => {
  it("asks for the caller's collections with membership for this exact item", async () => {
    const calls = serve([collection("c1", "Road trip", { itemCount: 2 })]);
    render(<AddToCollectionModal entityType="ebook" entityId="b1" title="Treasure Island" onClose={vi.fn()} />);
    expect(await dialog().findByText("Road trip")).toBeInTheDocument();
    expect(gets(calls)[0].path).toBe("/api/collections?entityType=ebook&entityId=b1");
    expect(dialog().getByText("Treasure Island")).toBeInTheDocument();
    expect(row("Road trip")).toHaveTextContent("2 items");
  });

  it("marks the collections that already hold it", async () => {
    serve([collection("c1", "Has it", { containsItem: true, itemId: "ci-9" }), collection("c2", "Lacks it", { containsItem: false })]);
    render(<AddToCollectionModal entityType="audiobook" entityId="b1" title="Book" onClose={vi.fn()} />);
    await dialog().findByText("Has it");
    expect(row("Has it")).toHaveClass("selected");
    expect(row("Lacks it")).not.toHaveClass("selected");
  });

  it.each<EntityType>(["audiobook", "ebook", "gallery", "quote"])(
    "adds a %s under its own type and refreshes the marks",
    async (entityType) => {
      const user = userEvent.setup();
      const calls = serve([collection("c1", "Favourites")]);
      render(<AddToCollectionModal entityType={entityType} entityId="x-1" title="Thing" onClose={vi.fn()} />);
      await user.click(await dialog().findByText("Favourites"));

      await waitFor(() => expect(posts(calls)).toHaveLength(1));
      expect(posts(calls)[0]).toEqual({
        path: "/api/collections/c1/items",
        method: "POST",
        body: { entityType, entityId: "x-1" }
      });
      // The list is asked for again, with the same type, to redraw the ✓.
      await waitFor(() => expect(gets(calls)).toHaveLength(2));
      expect(new Set(gets(calls).map((c) => c.path))).toEqual(new Set([`/api/collections?entityType=${entityType}&entityId=x-1`]));
    }
  );

  it("takes an item out of a collection that already holds it, by the membership row id", async () => {
    const user = userEvent.setup();
    const calls = serve([collection("c1", "Has it", { containsItem: true, itemId: "ci-9" })]);
    const onClose = vi.fn();
    render(<AddToCollectionModal entityType="gallery" entityId="p1" title="Photo" onClose={onClose} />);
    await user.click(await dialog().findByText("Has it"));
    await waitFor(() => expect(calls).toContainEqual({ path: "/api/collections/c1/items/ci-9", method: "DELETE", body: undefined }));
    expect(posts(calls)).toHaveLength(0);
    // Toggling keeps the dialog open for the next one.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("creates a collection by name and puts the item in it, typed", async () => {
    const user = userEvent.setup();
    const calls = serve([]);
    render(<AddToCollectionModal entityType="quote" entityId="q7" title="A saying" onClose={vi.fn()} />);
    expect(await dialog().findByText("No collections yet — create one below.")).toBeInTheDocument();

    await user.click(dialog().getByRole("button", { name: "New collection" }));
    const createAndAdd = dialog().getByRole("button", { name: "Create & add" });
    expect(createAndAdd).toBeDisabled();
    await user.type(dialog().getByPlaceholderText("New collection name…"), "  Grandma's sayings ");
    await user.click(createAndAdd);

    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[0]).toEqual({ path: "/api/collections", method: "POST", body: { name: "Grandma's sayings" } });
    expect(posts(calls)[1]).toEqual({ path: "/api/collections/created/items", method: "POST", body: { entityType: "quote", entityId: "q7" } });
    // Back to the list, with the create row folded away.
    await waitFor(() => expect(dialog().getByRole("button", { name: "New collection" })).toBeInTheDocument());
  });

  it("creates on Enter, and Escape folds the create row without closing the dialog", async () => {
    const user = userEvent.setup();
    const calls = serve([]);
    const onClose = vi.fn();
    render(<AddToCollectionModal entityType="ebook" entityId="b1" title="Book" onClose={onClose} />);
    await dialog().findByText("No collections yet — create one below.");

    await user.click(dialog().getByRole("button", { name: "New collection" }));
    await user.keyboard("{Escape}");
    expect(dialog().queryByPlaceholderText("New collection name…")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(dialog().getByRole("button", { name: "New collection" }));
    await user.type(dialog().getByPlaceholderText("New collection name…"), "Classics{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1].body).toEqual({ entityType: "ebook", entityId: "b1" });
  });

  it("shows why an add failed, and lets the row be tried again", async () => {
    const user = userEvent.setup();
    serve([collection("c1", "Favourites")], {
      onPost: () => { throw new Error("That item is no longer available"); }
    });
    render(<AddToCollectionModal entityType="audiobook" entityId="b1" title="Book" onClose={vi.fn()} />);
    await user.click(await dialog().findByText("Favourites"));
    expect(await dialog().findByText("That item is no longer available")).toBeInTheDocument();
    expect(dialog().getByText("Collections error")).toBeInTheDocument();
    expect(row("Favourites")).toBeEnabled();
  });

  it("reports a failed list load", async () => {
    mockApi.mockRejectedValue(new Error("offline"));
    render(<AddToCollectionModal entityType="audiobook" entityId="b1" title="Book" onClose={vi.fn()} />);
    expect(await dialog().findByText("offline")).toBeInTheDocument();
  });
});

describe("AddToCollectionModal — many items (the selection bar)", () => {
  it("lists collections by type only, and batch-adds the whole selection in one request", async () => {
    const user = userEvent.setup();
    const calls = serve([collection("c1", "Summer", { containsItem: true, itemId: "ignored" })]);
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(
      <AddToCollectionModal entityType="gallery" entityIds={["p1", "p2", "p3"]} title="3 items" onClose={onClose} onAdded={onAdded} />
    );
    await dialog().findByText("Summer");
    // No single entity, so no membership in the query.
    expect(gets(calls)[0].path).toBe("/api/collections?entityType=gallery");

    await user.click(row("Summer"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)).toEqual([
      { path: "/api/collections/c1/items/batch", method: "POST", body: { entityType: "gallery", entityIds: ["p1", "p2", "p3"] } }
    ]);
    // Never a DELETE: in bulk mode a click adds, whatever the row's mark says.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    // The count reported is what the server actually added.
    expect(onAdded).toHaveBeenCalledWith("Summer", 2);
  });

  it("creates a collection and batch-adds into it", async () => {
    const user = userEvent.setup();
    const calls = serve([]);
    const onAdded = vi.fn();
    render(<AddToCollectionModal entityType="ebook" entityIds={["b1", "b2"]} title="2 books" onClose={vi.fn()} onAdded={onAdded} />);
    await dialog().findByText("No collections yet — create one below.");
    await user.click(dialog().getByRole("button", { name: "New collection" }));
    await user.type(dialog().getByPlaceholderText("New collection name…"), "Reading list");
    await user.click(dialog().getByRole("button", { name: "Create & add" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("Reading list", 2));
    expect(posts(calls)).toEqual([
      { path: "/api/collections", method: "POST", body: { name: "Reading list" } },
      { path: "/api/collections/created/items/batch", method: "POST", body: { entityType: "ebook", entityIds: ["b1", "b2"] } }
    ]);
  });
});

// ── Every call site says what it is adding ──
//
// entityType is a required prop now (it once defaulted to "audiobook", which
// stored ebooks under the wrong type), so TypeScript already refuses an omitted
// one. What the compiler can't see is whether the type passed matches the
// surface: a gallery page passing "audiobook" compiles fine. This reads every
// `<AddToCollectionModal` in the app and pins what each surface passes. A NEW
// call site fails here on purpose — add it to the table with the type it must
// send, after checking it against the media type that surface shows.

// Keyed by path under src/, with forward slashes whatever the OS.
const SRC = join(import.meta.dirname, "..", "src");
const SOURCES: Record<string, string> = Object.fromEntries(
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => [file.split(/[\\/]/).join("/"), readFileSync(join(SRC, file), "utf8")])
);

/** The opening element's text, from `<AddToCollectionModal` to its closing `/>` or `>`. */
function openingElements(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("<AddToCollectionModal", from);
    if (start < 0) return out;
    let depth = 0;
    let i = start;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && ch === ">") break;
    }
    out.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

const entityTypeProp = (element: string): string | null => {
  const match = /\sentityType=("[^"]*"|\{[^}]*\})/.exec(element);
  return match ? match[1] : null;
};

// file → the entityType expression each of its call sites passes.
const EXPECTED: Record<string, string[]> = {
  // Book detail serves both /audiobooks/books/:id and /ebooks/books/:id; the
  // type is derived from the book's content (no audio + a document = ebook).
  "features/audiobooks/BookDetailPage.tsx": ['{isEbook ? "ebook" : "audiobook"}'],
  // CatalogPage is drawn for kind: "audiobook" | "ebook" — the same union.
  "features/audiobooks/catalog/CatalogPage.tsx": ["{kind}"],
  "features/gallery/GalleryLightbox.tsx": ['"gallery"'],
  "features/gallery/GalleryPage.tsx": ['"gallery"'],
  "features/library/QuotesPage.tsx": ['"quote"']
};

describe("AddToCollectionModal call sites", () => {
  const sites = Object.entries(SOURCES)
    .map(([file, source]) => ({ file, elements: openingElements(source) }))
    .filter((site) => site.elements.length > 0 && !site.file.endsWith("collections/AddToCollectionModal.tsx"));

  it("finds the call sites it knows about, and no others", () => {
    expect(sites.map((s) => s.file).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("passes an explicit entityType at every one", () => {
    for (const site of sites) {
      for (const element of site.elements) {
        expect(entityTypeProp(element), `${site.file}: ${element.slice(0, 120)}`).not.toBeNull();
      }
    }
  });

  it("passes the type that matches each surface", () => {
    for (const site of sites) {
      expect(site.elements.map(entityTypeProp), site.file).toEqual(EXPECTED[site.file]);
    }
  });

  it("only ever passes a type the server can collect", () => {
    const collectable = new Set(["audiobook", "ebook", "gallery", "quote"]);
    for (const site of sites) {
      for (const element of site.elements) {
        for (const literal of (entityTypeProp(element) ?? "").match(/"([^"]+)"/g) ?? []) {
          expect(collectable.has(literal.slice(1, -1)), `${site.file} passes ${literal}`).toBe(true);
        }
      }
    }
  });
});
