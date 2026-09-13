import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSignedIn } from "./helpers/session";
import { setAppLanguage } from "../src/i18n";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
const navigate = vi.fn();
vi.mock("../src/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/router")>();
  return { ...actual, navigate: (...args: unknown[]) => navigate(...args) };
});

const { api } = await import("../src/api");
const { GalleryPage } = await import("../src/features/gallery/GalleryPage");

// The gallery page is a shell over one component per view (features/gallery/page/).
// These mount it on every view the router can name, against a small library, and
// check each draws its own content — the seam between the shell and the views is
// what a refactor of this page is most likely to break.

const asset = (id: string, over: Record<string, unknown> = {}) => ({
  id, libraryId: "lib", libraryName: "Photos", folderPath: "Trips/a.jpg", folder: "Trips",
  kind: "photo", title: `${id}.jpg`, description: null,
  takenAt: "2019-07-04T10:00:00Z", takenPrecision: "day", takenApprox: false,
  placeText: null, reviewedAt: null, reviewedBy: null, addedAt: "2020-01-01T00:00:00Z",
  width: 100, height: 100, orientation: null, rotation: 0, durationSeconds: null, playable: null,
  coverUrl: null, previewUrl: null, saved: false, tags: [], people: [],
  ...over
});

const library = {
  id: "lib", name: "Photos", bookCount: 3, inbox: false, role: null, scanStatus: "idle",
  canWrite: true, canDelete: true, canDownload: true, canUpload: false, canCurate: true,
  uploadExtensions: [], maxUploadMB: null
};

// A finished year and the one still running: only a year that is over gets a card.
const THIS_YEAR = new Date().getFullYear();
const yearReview = (year: number) => ({
  id: `year-${year}`, title: `${year} in review`, subtitle: "server words", coverUrl: null,
  count: 2, itemIds: ["y1", "y2"], year
});

function mockGallery({ yearReviews = [yearReview(THIS_YEAR), yearReview(2025)] }: { yearReviews?: unknown[] } = {}) {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/library/gallery-libraries") return { libraries: [library] } as never;
    if (path.startsWith("/api/library/gallery/year-review")) return { suggestions: yearReviews } as never;
    if (path === "/api/library/gallery/assets/lookup") {
      const file = (id: string) => ({ fileUrl: `/api/library/gallery/assets/${id}/file`, playbackUrl: `/api/library/gallery/assets/${id}/file` });
      return { assets: [asset("y1", { title: "Snow.jpg", ...file("y1") }), asset("y2", file("y2"))] } as never;
    }
    if (path.startsWith("/api/library/gallery/facets")) return { kinds: [], years: [], withGps: 0, people: [], tags: [], cameras: [] } as never;
    if (path.startsWith("/api/library/gallery/memories/suggestions")) return { suggestions: [{ id: "s1", title: "Summer trip", subtitle: "July 2019", coverUrl: null, count: 2, itemIds: ["a1", "a2"] }] } as never;
    if (path.startsWith("/api/library/gallery/memories")) return { precision: "day", groups: [{ year: 2019, count: 1, precision: "day", items: [asset("m1")] }] } as never;
    if (path === "/api/library/gallery/timeline") return { assets: [asset("a1"), asset("a2")], total: 2 } as never;
    if (path.startsWith("/api/library/gallery/folders?")) return { parent: "", parentLocked: false, folders: [{ name: "Trips", path: "Trips", assetCount: 2, coverUrl: null, locked: false }], assets: [], total: 0 } as never;
    if (path === "/api/library/gallery/albums") return { albums: [{ id: "al1", name: "Wedding", description: null, itemCount: 4, coverUrl: null, sortMode: "taken_at", canEdit: true, updatedAt: "" }] } as never;
    if (path.startsWith("/api/library/gallery/slideshows/settings")) return { libraries: [], defaultLibraryId: null } as never;
    if (path === "/api/library/gallery/slideshows") return { slideshows: [{ id: "ss1", name: "Grandma at 90", itemCount: 12, coverUrl: null, transition: "crossfade", slideSeconds: 5, transitionSeconds: 2, musicTrackId: null, renderStatus: "draft", canEdit: true, updatedAt: "" }] } as never;
    if (path.startsWith("/api/library/gallery/people")) return { people: [{ id: "p1", name: "Mama", faceCount: 12, coverUrl: null }] } as never;
    if (path.startsWith("/api/library/gallery/face-settings")) return { libraries: [] } as never;
    if (path.startsWith("/api/library/gallery/map")) return { points: [] } as never;
    return {} as never;
  });
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  navigate.mockReset();
  mockGallery();
});

describe("GalleryPage views", () => {
  it("draws the timeline, with the On this day strip above it", async () => {
    renderSignedIn(<GalleryPage view="timeline" />);
    expect(await screen.findByRole("heading", { name: "July 4, 2019" })).toBeInTheDocument();
    expect(document.querySelectorAll(".gallery-memory-card")).toHaveLength(1);
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  // The day headings are the app's most visible dates, and they used to come out
  // of the BROWSER's locale — English headings over a Russian interface. They
  // follow the interface language now, ordered the way Russian orders a date.
  it("writes the timeline's day headings in the interface language", async () => {
    await setAppLanguage("ru");
    try {
      renderSignedIn(<GalleryPage view="timeline" />);
      expect(await screen.findByRole("heading", { name: "4 июля 2019 г." })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "July 4, 2019" })).not.toBeInTheDocument();
    } finally {
      await setAppLanguage("en");
    }
  });

  it("draws the folder tree", async () => {
    renderSignedIn(<GalleryPage view="folder" />);
    expect(await screen.findByRole("button", { name: /Trips/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All folders" })).toBeInTheDocument();
  });

  it("draws the albums list and its create dialog", async () => {
    const user = userEvent.setup();
    renderSignedIn(<GalleryPage view="albums" />);
    expect(await screen.findByText("Wedding")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New album/ }));
    expect(await screen.findByRole("dialog", { name: "Create album" })).toBeInTheDocument();
  });

  it("draws the slideshows list with the suggested memories", async () => {
    renderSignedIn(<GalleryPage view="slideshows" />);
    expect(await screen.findByText("Grandma at 90")).toBeInTheDocument();
    expect(screen.getByText("Summer trip")).toBeInTheDocument();
  });

  it("draws the people grid", async () => {
    renderSignedIn(<GalleryPage view="people" />);
    expect(await screen.findByText("Mama")).toBeInTheDocument();
  });

  it("draws the memories view by year", async () => {
    renderSignedIn(<GalleryPage view="memories" />);
    await waitFor(() => expect(document.querySelector("#gallery-memories-2019")).not.toBeNull());
  });

  it("opens Memories with a finished year in review, and plays it in the gallery's own viewer", async () => {
    const user = userEvent.setup();
    renderSignedIn(<GalleryPage view="memories" />);
    expect(await screen.findByRole("heading", { name: "Your years in photos" })).toBeInTheDocument();
    // The year still running is not offered: a look back belongs to a year that is over.
    expect(screen.queryByText(`Your ${THIS_YEAR} in photos`)).not.toBeInTheDocument();
    // Worded by the app, not the server (whose title is English-only).
    expect(screen.queryByText("2025 in review")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Your 2025 in photos/ }));
    expect(api).toHaveBeenCalledWith("/api/library/gallery/assets/lookup", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ itemIds: ["y1", "y2"] })
    }));
    // The lightbox, already playing, on the film's first photo.
    const viewer = await screen.findByRole("dialog", { name: "Snow.jpg" });
    expect(viewer).toHaveClass("is-playing");
    expect(within(viewer).getByText("1 / 2")).toBeInTheDocument();
  });

  it("leaves the year row out when the server has no year to offer", async () => {
    mockGallery({ yearReviews: [] });
    renderSignedIn(<GalleryPage view="memories" />);
    await waitFor(() => expect(document.querySelector("#gallery-memories-2019")).not.toBeNull());
    expect(screen.queryByRole("heading", { name: "Your years in photos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create slideshow" })).not.toBeInTheDocument();
  });

  it("keeps Memories worth opening on a day with no anniversary when there is a year", async () => {
    vi.mocked(api).mockReset();
    mockGallery();
    const base = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => (
      path.startsWith("/api/library/gallery/memories?") ? { precision: "day", groups: [] } as never : base(path, init)
    ));
    renderSignedIn(<GalleryPage view="memories" />);
    expect(await screen.findByRole("heading", { name: "Your years in photos" })).toBeInTheDocument();
    expect(screen.getByText("Nothing was taken on this day in past years.")).toBeInTheDocument();
    expect(screen.queryByText("No memories yet")).not.toBeInTheDocument();
  });

  // The phone's stand-in for the left nav. One view is where you are, so each is a
  // menuitemradio with the current one checked, and the keyboard is SortMenu's.
  it("offers the views in a keyboard-operable Browse menu on a phone, the current one checked", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query.includes("max-width: 740px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }) as unknown as MediaQueryList);
    try {
      renderSignedIn(<GalleryPage view="albums" />);
      await screen.findByText("Wedding");
      const trigger = screen.getByRole("button", { name: "Browse gallery views" });
      await user.click(trigger);
      const menu = screen.getByRole("menu", { name: "Browse" });
      const albums = within(menu).getByRole("menuitemradio", { name: "Albums" });
      expect(albums).toHaveAttribute("aria-checked", "true");
      expect(within(menu).getAllByRole("menuitemradio", { checked: true })).toHaveLength(1);
      // Focus opens on the view you are in, and the arrows walk from there.
      expect(albums).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(within(menu).getByRole("menuitemradio", { name: "Slideshows" })).toHaveFocus();
      await user.keyboard("{Home}");
      expect(within(menu).getByRole("menuitemradio", { name: "Gallery" })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "Browse" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();

      await user.click(trigger);
      await user.keyboard("{ArrowDown}{Enter}");
      expect(navigate).toHaveBeenCalledWith(expect.stringContaining("slideshows"));
      expect(trigger).toHaveFocus();
    } finally {
      vi.mocked(window.matchMedia).mockRestore();
    }
  });

  it("enters selection from the toolbar and offers the bulk verbs", async () => {
    const user = userEvent.setup();
    renderSignedIn(<GalleryPage view="timeline" />);
    await screen.findByRole("heading", { name: "July 4, 2019" });
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByRole("button", { name: /Like/ })).toBeDisabled();
    await user.click(screen.getByTitle("Select everything loaded so far"));
    expect(screen.getByRole("button", { name: /Like/ })).toBeEnabled();
  });
});
