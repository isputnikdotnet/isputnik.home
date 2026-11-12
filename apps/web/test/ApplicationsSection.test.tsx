import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { ALL_SECTIONS_ON } from "../src/app/sections";
import { controlHref, controlHrefFrom, navigate, replaceNavigate } from "../src/router";
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
  it("shows measured media separately and retries unavailable app-file sizes", async () => {
    const original = mockApi.getMockImplementation()!;
    let filesAvailable = false;
    mockApi.mockImplementation(async (path, options) => {
      if (path.includes("gallery-libraries")) return { libraries: [
        { id: "photos", name: "Photos", totalSizeBytes: 2048 },
        { id: "house", name: "App files", role: "app-files", totalSizeBytes: 999999 }
      ] };
      if (path === "/api/storage/app-storage/contents" && filesAvailable) return {
        rooms: [{ room: "inbox", bytes: 1024, complete: true }],
        appFiles: { library: null, folders: [] }
      };
      return original(path, options);
    });
    render(<AppSetupSection app="gallery" />);
    const storage = await screen.findByRole("region", { name: "Disk usage" });
    expect(within(storage).getByRole("link", { name: /^Library media/ })).toHaveTextContent("2.00 KB");
    expect(await within(storage).findByText("At least 2.00 KB")).toBeInTheDocument();
    // Shared App files isn't a second Gallery library or part of its media total.
    expect(screen.getByRole("link", { name: /^LibrariesFolders/ })).toHaveTextContent("1 library");
    filesAvailable = true;
    await userEvent.click(await within(storage).findByRole("button", { name: "Retry app-file measurements" }));
    await waitFor(() => expect(within(storage).getByText("3.00 KB")).toBeInTheDocument());
    expect(within(storage).queryByText(/At least/)).not.toBeInTheDocument();
  });
  it.each([["gallery", "gallery"], ["videos", "video"], ["ebooks", "ebook"], ["audiobooks", "audiobook"]] as const)("opens only %s libraries", async (app, type) => {
    render(<AppSetupSection app={app} />);
    expect(await screen.findByRole("link", { name: /^LibrariesFolders/ })).toHaveAttribute("href", controlHref("libraries") + "?type=" + type);
    if (app !== "videos") expect(screen.getByRole("link", { name: /^Who can use it/ })).toHaveAttribute("href", controlHref("libraries") + "?type=" + type);
  });
  it.each([["videos", "video"], ["games", "games"]] as const)("links %s to its own backup details", async (app, container) => {
    render(<AppSetupSection app={app} />);
    expect(await screen.findByRole("link", { name: /^Backup/ })).toHaveAttribute("href", controlHref("backup") + "?show=app%3A" + container);
  });

  it("links Gallery to Home backups and filtered troubleshooting", async () => {
    render(<AppSetupSection app="gallery" />);
    expect(await screen.findByRole("link", { name: /^Backup/ })).toHaveAttribute("href", controlHref("backup"));
    expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute("href", controlHref("logs") + "?application=gallery");
  });

  it("returns from a shared editor to the originating workspace tab, then the directory", async () => {
    act(() => {
      navigate(controlHref("ebooksSetup"));
      replaceNavigate(controlHref("ebooksOrganize"));
      navigate(controlHrefFrom("categories", "ebooks"));
    });
    const view = render(<ControlSectionHead section="categories" />);
    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(window.location.pathname).toBe(controlHref("ebooksOrganize")));
    view.rerender(<ControlSectionHead section="ebooksOrganize" />);
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
