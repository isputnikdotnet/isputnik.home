import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ALL_SECTIONS_ON } from "../src/app/sections";
import { controlHref, controlHrefFrom, navigate } from "../src/router";
import { resetApplicationsCache } from "../src/features/control/applications";
import { ApplicationsSection } from "../src/features/control/sections/ApplicationsSection";
import { AppSetupSection } from "../src/features/control/sections/AppSetupSection";
import { ControlSectionHead } from "../src/features/control/ControlSectionHead";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);
let failLibraries = false;
let failConfig = false;

beforeEach(() => {
  resetApplicationsCache();
  failLibraries = false;
  failConfig = false;
  window.history.replaceState({}, "", controlHref("applications"));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mockApi.mockReset();
  mockApi.mockImplementation(async (path) => {
    if (path === "/api/config") {
      if (failConfig) throw new Error("Configuration unavailable");
      return { config: { sections: { ...ALL_SECTIONS_ON, games: false } } };
    }
    if (path === "/api/apps/admin/status") return { apps: [] };
    if (path.includes("-libraries")) {
      if (failLibraries && path.includes("gallery")) throw new Error("Library check failed");
      return { libraries: path.includes("gallery") ? [{ id: "photos", name: "Photos" }] : [] };
    }
    throw new Error("Optional measurements unavailable");
  });
});

describe("Applications directory", () => {
  it("shows seven applications and separate shared tools with specific status", async () => {
    render(<ApplicationsSection />);
    const apps = screen.getByRole("region", { name: "Your applications" });
    expect(within(apps).getAllByRole("link")).toHaveLength(7);
    await waitFor(() => expect(within(apps).getByRole("link", { name: /^Gallery/ })).toHaveTextContent("Ready"));
    expect(within(apps).getByRole("link", { name: /^Videos/ })).toHaveTextContent("Not connected");
    expect(within(apps).getByRole("link", { name: /^Ebooks/ })).toHaveTextContent("No libraries");
    expect(within(apps).getByRole("link", { name: /^Games/ })).toHaveTextContent("Hidden from menu");
    const shared = screen.getByRole("region", { name: "Shared tools" });
    expect(within(shared).getByRole("link", { name: /^Book categories/ })).toHaveAttribute("href", controlHrefFrom("categories", "shared"));
    expect(within(shared).getByRole("link", { name: /^Tags/ })).toHaveAttribute("href", controlHrefFrom("tags", "shared"));
  });

  it("distinguishes a failed library check from an empty library list, and retries", async () => {
    failLibraries = true;
    render(<ApplicationsSection />);
    const gallery = screen.getByRole("link", { name: /^Gallery/ });
    await waitFor(() => expect(gallery).toHaveTextContent("Status unavailable"));
    expect(gallery).not.toHaveTextContent("No libraries");
    failLibraries = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(gallery).toHaveTextContent("Ready"));
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("recovers from a failed configuration request", async () => {
    failConfig = true;
    render(<ApplicationsSection />);
    await screen.findByText("Configuration unavailable");
    expect(screen.getByRole("link", { name: /^Stories/ })).toHaveTextContent("Status unavailable");
    failConfig = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /^Stories/ })).toHaveTextContent("Ready"));
  });
});

describe("Application Overview and return navigation", () => {
  it("doesn't count the shared App files library as Gallery's", async () => {
    const original = mockApi.getMockImplementation()!;
    mockApi.mockImplementation(async (path, options) => {
      if (path.includes("gallery-libraries")) return { libraries: [
        { id: "photos", name: "Photos", totalSizeBytes: 2048 },
        { id: "house", name: "App files", role: "app-files", totalSizeBytes: 999999 }
      ] };
      return original(path, options);
    });
    render(<AppSetupSection app="gallery" />);
    const tiles = await screen.findByRole("region", { name: "At a glance" });
    // Libraries and On disk open the pages that list them; Storage is not drawn here.
    expect(within(tiles).getByRole("link", { name: "Libraries" })).toHaveAttribute("href", controlHref("libraries") + "?type=gallery");
    expect(within(tiles).getByRole("link", { name: "On disk" })).toHaveAttribute("href", controlHref("storage"));
    expect(within(tiles).getByText("1")).toBeInTheDocument();
    expect(within(tiles).getByText("2.00 KB")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Storage" })).not.toBeInTheDocument();
  });
  // Every application with libraries: its Libraries card opens them, and where who
  // sees them is set, the row is named for where it goes (2026-11-19).
  it.each([["gallery", "gallery"], ["videos", "video"], ["ebooks", "ebook"], ["audiobooks", "audiobook"]] as const)("opens only %s libraries", async (app, type) => {
    render(<AppSetupSection app={app} />);
    const tiles = await screen.findByRole("region", { name: "At a glance" });
    expect(within(tiles).getByRole("link", { name: "Libraries" })).toHaveAttribute("href", controlHref("libraries") + "?type=" + type);
    if (app !== "videos") expect(screen.getByRole("link", { name: /^Manage libraries/ })).toHaveAttribute("href", controlHref("libraries") + "?type=" + type);
  });

  // Backup is a server's or a container's, on Services, never an application's.
  it.each(["videos", "games", "stories"] as const)("gives %s no Backup", async (app) => {
    render(<AppSetupSection app={app} />);
    await screen.findByRole("region", { name: "At a glance" });
    expect(screen.queryByRole("link", { name: /^Backup/ })).not.toBeInTheDocument();
  });

  // The rest in Gallery's shape too: their own cards, Organize where they have it.
  it("lays every application out with cards, its menu and access, and the side column", async () => {
    for (const app of ["videos", "ebooks", "audiobooks", "stories", "familyTree", "games"] as const) {
      const view = render(<AppSetupSection app={app} />);
      expect(await screen.findByRole("region", { name: "At a glance" }), app).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Visibility & access" }), app).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Activity & troubleshooting" }), app).toBeInTheDocument();
      view.unmount();
    }
    // Ebooks' Organize: Book categories and Tags, opened from Ebooks.
    render(<AppSetupSection app="ebooks" />);
    const organize = await screen.findByRole("region", { name: "Organize" });
    expect(within(organize).getByRole("link", { name: /^Book categories/ })).toHaveAttribute("href", controlHrefFrom("categories", "ebooks"));
    expect(within(organize).getByRole("link", { name: /^Tags/ })).toHaveAttribute("href", controlHrefFrom("tags", "ebooks"));
  });

  // Backup is a server's or a container's, not an application's (owner, 2026-11-19).
  it("gives Gallery filtered troubleshooting and no Backup", async () => {
    render(<AppSetupSection app="gallery" />);
    expect(await screen.findByRole("link", { name: "Logs" })).toHaveAttribute("href", controlHref("logs") + "?application=gallery");
    expect(screen.queryByRole("link", { name: /^Backup/ })).not.toBeInTheDocument();
  });

  // Laid out as a Diagnostics page (owner, 2026-11-19): cards, each library, its
  // tools, and the side column of menu and access, backup, events and tasks.
  it("opens Gallery on cards, then its menu and access, what is on, and Organize", async () => {
    const original = mockApi.getMockImplementation()!;
    mockApi.mockImplementation(async (path, options) => {
      if (path.includes("gallery-libraries")) return { libraries: [
        { id: "photos", name: "Photos", scanStatus: "idle", lastScannedAt: "2026-11-19T08:00:00.000Z" },
        { id: "kids", name: "Kids", scanStatus: "error" }
      ] };
      if (path === "/api/status") return { status: {
        libraryStats: { libraries: [] }, ebookStats: { libraries: [] },
        galleryStats: { totalPhotos: 1234, totalVideos: 5, totalSizeBytes: 4096, libraries: [
          { id: "photos", itemCount: 1200, totalSizeBytes: 3072 }, { id: "kids", itemCount: 39, totalSizeBytes: 1024 }
        ] },
        faceStats: { enabled: true, people: 7, faces: 90, scannedItems: 1000 }
      } };
      if (path === "/api/photo-sync/networks") return { networks: [], address: null };
      if (path === "/api/storage/personal-libraries") return { settings: { enabled: true }, libraries: [{}, {}] };
      if (path === "/api/map/settings") return { settings: { cache: false }, places: { present: true } };
      if (path === "/api/photo-sync/phones") return { phones: [
        { lastSeen: "2026-11-19T07:00:00.000Z", stale: false, atLimit: false, problem: null },
        { lastSeen: null, stale: true, atLimit: false, problem: null }
      ] };
      return original(path, options);
    });
    render(<AppSetupSection app="gallery" />);
    const tiles = await screen.findByRole("region", { name: "At a glance" });
    await waitFor(() => expect(within(tiles).getByText("1,234")).toBeInTheDocument());
    expect(within(tiles).getByText("and 5 videos")).toBeInTheDocument();
    expect(within(tiles).getByText("1 scan failed")).toBeInTheDocument();
    expect(within(tiles).getByText("4.00 KB")).toBeInTheDocument();
    expect(within(tiles).getByText("90 faces found")).toBeInTheDocument();
    expect(await within(tiles).findByText("1 needs a look")).toBeInTheDocument();
    // Healthy: the Status card says so, no banner.
    expect(within(tiles).getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Gallery is ready")).not.toBeInTheDocument();
    // The menu switch and Access sit in the main column, not beside it.
    const visibility = screen.getByRole("region", { name: "Visibility & access" });
    expect(within(visibility).getByRole("switch", { name: /Show Gallery in the menu/ })).toBeInTheDocument();
    expect(within(visibility).getByRole("link", { name: /^Manage libraries/ })).toBeInTheDocument();
    expect(visibility.closest(".diag-video-main")).not.toBeNull();
    // What is on and what is not.
    const features = screen.getByRole("region", { name: "Features" });
    // One row per page: Device Sync's says phone backup and personal libraries,
    // Maps' says offline maps and place names.
    await waitFor(() => expect(within(features).getByRole("link", { name: /^Phone backup/ })).toHaveTextContent("Personal libraries on, 2 so farOff"));
    expect(within(features).getAllByRole("link")).toHaveLength(4);
    // Search by what a photo shows: its own page; no On/Off until its settings answer.
    const sceneRow = within(features).getByRole("link", { name: /^Search by content/ });
    expect(sceneRow).toHaveAttribute("href", controlHref("sceneSearch"));
    expect(sceneRow).toHaveTextContent("Find photos by what they show, with no tagging.");
    expect(within(features).getByRole("link", { name: /^Face recognition/ })).toHaveTextContent(/Not paired.*Off$/);
    expect(within(features).getByRole("link", { name: /^Offline maps/ })).toHaveTextContent("Place names installedOff");
    const organize = screen.getByRole("region", { name: "Organize" });
    expect(within(organize).getByRole("link", { name: /^Duplicate cleanup/ })).toHaveAttribute("href", controlHref("duplicateCleanup"));
    expect(within(organize).getByRole("link", { name: /^Tags/ })).toHaveAttribute("href", controlHrefFrom("tags", "gallery"));
    expect(screen.queryByRole("region", { name: "Libraries" })).not.toBeInTheDocument();
    const side = screen.getByRole("region", { name: "Activity & troubleshooting" });
    expect(within(side).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", controlHref("tasks") + "?application=gallery");
  });

  it("returns from a shared editor to the originating workspace tab, then the directory", async () => {
    act(() => {
      navigate(controlHref("ebooksSetup"));
      navigate(controlHrefFrom("categories", "ebooks"));
    });
    const view = render(<ControlSectionHead section="categories" />);
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe(controlHref("ebooksSetup")));
    view.rerender(<ControlSectionHead section="ebooksSetup" />);
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe(controlHref("applications")));
  });

  it("falls back to Applications for a direct shared-tool link without adding history", async () => {
    window.history.replaceState({}, "", controlHrefFrom("categories", "shared"));
    const length = window.history.length;
    render(<ControlSectionHead section="categories" />);
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(window.location.pathname).toBe(controlHref("applications"));
    expect(window.history.length).toBe(length);
  });
});
