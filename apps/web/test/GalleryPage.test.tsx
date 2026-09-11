import { screen, waitFor } from "@testing-library/react";
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
  id: "lib", name: "Photos", bookCount: 3, inbox: false, appStorage: false, scanStatus: "idle",
  canWrite: true, canDelete: true, canDownload: true, canUpload: false, canCurate: true,
  uploadExtensions: [], maxUploadMB: null
};

function mockGallery() {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/library/gallery-libraries") return { libraries: [library] } as never;
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
