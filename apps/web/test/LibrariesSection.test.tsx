import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { LibrariesSection } from "../src/features/control/sections/LibrariesSection";
import { librariesHref } from "../src/features/control/links";
import { navigate } from "../src/router";

vi.mock("../src/api", () => ({ api: vi.fn() }));
vi.mock("../src/app/useVideoAvailable", () => ({ useVideoAvailable: () => true }));
beforeEach(() => {
  window.history.replaceState({}, "", librariesHref("gallery"));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(api).mockReset().mockImplementation(async (path) => {
    if (path === "/api/library/settings") return { settings: { thumbnailPathReady: true } };
    if (path === "/api/storage/roots") return { roots: [{ id: "root", name: "Media", path: "/media" }] };
    if (path === "/api/users") return { users: [] };
    if (path === "/api/groups") return { groups: [] };
    if (path.endsWith("/members")) return { members: [] };
    if (path === "/api/scheduled-jobs") return { jobs: [
      { key: "scan_gallery_libraries", enabled: true, nextRunAt: "2026-11-20T09:37:00.000Z" },
      { key: "backup_full", enabled: true, nextRunAt: "2026-11-20T01:00:00.000Z" }
    ] };
    if (path.includes("-libraries")) {
      const type = path.split("/").at(-1)!.split("-libraries")[0];
      return { libraries: [{ id: type, name: `${type} collection`, type, createdAt: "2026-01-01", scanStatus: "idle", lastScannedAt: null,
        visibility: "public", ownerId: null, ownerType: null, canManageLibrary: true, fileCount: 1, totalSizeBytes: 1024 }] };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

it("opens with only the linked application's libraries", async () => {
  render(<LibrariesSection />);
  await screen.findByText("gallery collection");
  expect(screen.queryByText("ebook collection")).not.toBeInTheDocument();
});

// Back to the list (owner, 2026-11-19): a row's menu — its ⋯ or a right-click — has
// every action, and Edit opens one popup laid out as the Add library wizard.
it("gives each row one menu, by ⋯ or a right-click: Edit, Rescan, Delete", async () => {
  const user = userEvent.setup();
  render(<LibrariesSection />);
  await screen.findByText("gallery collection");
  await user.click(screen.getByRole("button", { name: "More for gallery collection" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Edit…", "Rescan", "Delete library…"]);
  await user.keyboard("{Escape}");
  fireEvent.contextMenu(screen.getByText("gallery collection"), { clientX: 40, clientY: 60 });
  expect(await screen.findByRole("menu", { name: "More for gallery collection" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "Edit…" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

// One window of sections, the old Manage page's content arranged by what it is
// about (owner, 2026-11-19); the step row jumps between them.
it("edits a library in one window of sections, with Rescan and Delete at hand", async () => {
  const user = userEvent.setup();
  render(<LibrariesSection />);
  await user.click(await screen.findByText("gallery collection"));
  const dialog = await screen.findByRole("dialog");
  const steps = within(dialog).getByRole("list", { name: "Settings of gallery collection" });
  expect(within(steps).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
    "1Summary", "2Name and access", "3Files and scanning", "4Organizing", "5About"
  ]);
  // Every section is in the one window.
  for (const name of ["Summary", "Name and access", "Files and scanning", "Organizing", "About"]) {
    expect(within(dialog).getByRole("region", { name })).toBeInTheDocument();
  }
  expect(within(dialog).getByLabelText("Library name")).toHaveValue("gallery collection");
  // Members and groups belong to Name and access; Mode to Files and scanning.
  const access = within(dialog).getByRole("region", { name: "Name and access" });
  expect(within(access).getByRole("region", { name: "Members and groups" })).toBeInTheDocument();
  const files = within(dialog).getByRole("region", { name: "Files and scanning" });
  expect(within(files).getByLabelText("Mode")).toHaveValue("managed");
  // A step jumps to its section and is the one lit.
  await user.click(within(steps).getByRole("button", { name: /About/ }));
  expect(within(steps).getByRole("button", { name: /About/ }).closest("li")).toHaveAttribute("aria-current", "step");
  expect(within(dialog).getByRole("button", { name: /^Rescan/ })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /Delete library/ })).toBeInTheDocument();
});

it("opens a library's own address as the list with its popup", async () => {
  window.history.replaceState({}, "", "/control/libraries/gallery");
  render(<LibrariesSection libraryId="gallery" />);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Library name")).toHaveValue("gallery collection");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(window.location.pathname).toBe("/control/libraries"));
});

it("lets the user show all types, keeps that choice in the URL, and restores Back", async () => {
  render(<LibrariesSection />);
  await screen.findByText("gallery collection");
  // A chip per type, with its count; All shows every library.
  await userEvent.click(screen.getByRole("button", { name: /^All/ }));
  expect(await screen.findByText("ebook collection")).toBeInTheDocument();
  expect(window.location.search).toBe("");
  act(() => navigate(librariesHref("video")));
  await waitFor(() => expect(screen.queryByText("ebook collection")).not.toBeInTheDocument());
  expect(screen.getByText("video collection")).toBeInTheDocument();
  act(() => window.history.back());
  await waitFor(() => expect(screen.getByText("ebook collection")).toBeInTheDocument());
});

it("ignores an invalid type rather than showing an empty filtered list", async () => {
  window.history.replaceState({}, "", "/control/libraries?type=invalid");
  render(<LibrariesSection />);
  expect(await screen.findByText("gallery collection")).toBeInTheDocument();
  expect(screen.getByText("ebook collection")).toBeInTheDocument();
});

// Cards, chips and the side column around the table (owner, 2026-11-19).
it("opens on cards of every library, a chip per type and Personal, and where scanning is looked after", async () => {
  window.history.replaceState({}, "", "/control/libraries");
  render(<LibrariesSection />);
  const tiles = await screen.findByRole("region", { name: "At a glance" });
  await waitFor(() => expect(within(tiles).getAllByText("4")).toHaveLength(2));
  expect(within(tiles).getByText("across 4 types")).toBeInTheDocument();
  expect(within(tiles).getByRole("link", { name: "On disk" })).toHaveAttribute("href", "/control/libraries/statistics");
  // The next library scan, not the next backup.
  expect(within(tiles).getByText(/^next /)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /^Gallery/ })).toHaveAttribute("aria-pressed", "false");
  const scanning = screen.getByRole("region", { name: "Scanning" });
  expect(within(scanning).getByRole("button", { name: /^Rescan all/ })).toBeInTheDocument();
  expect(within(scanning).getByRole("link", { name: /^Scan schedules/ })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Where files live" })).toBeInTheDocument();
});

it("pages a long list twenty at a time", async () => {
  window.history.replaceState({}, "", "/control/libraries?type=gallery");
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/library/settings") return { settings: { thumbnailPathReady: true } };
    if (path === "/api/storage/roots") return { roots: [{ id: "root", name: "Media", path: "/media" }] };
    if (path === "/api/users") return { users: [] };
    if (path === "/api/groups") return { groups: [] };
    if (path.endsWith("/members")) return { members: [] };
    if (path === "/api/scheduled-jobs") return { jobs: [] };
    if (path.includes("gallery-libraries")) return { libraries: Array.from({ length: 25 }, (_, index) => ({
      id: `g${index + 1}`, name: `Album ${String(index + 1).padStart(2, "0")}`, type: "gallery", createdAt: `2026-01-${String(index + 1).padStart(2, "0")}`,
      scanStatus: "idle", lastScannedAt: null, visibility: "public", ownerId: null, ownerType: null, canManageLibrary: true, fileCount: 1, totalSizeBytes: 1
    })) };
    if (path.includes("-libraries")) return { libraries: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
  render(<LibrariesSection />);
  await screen.findByText("Album 25");
  expect(document.querySelectorAll(".library-table tbody tr")).toHaveLength(20);
  await userEvent.click(within(screen.getByRole("navigation", { name: "Libraries pages" })).getByRole("button", { name: /next/i }));
  await waitFor(() => expect(document.querySelectorAll(".library-table tbody tr")).toHaveLength(5));
  expect(screen.getByText("Album 01")).toBeInTheDocument();
});
