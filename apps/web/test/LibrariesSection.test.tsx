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

// A row's menu — its ⋯ or a right-click — has every action; Edit, like a click on the
// row, opens the library's own page (the full Manage page; the one popup of every
// setting lasted a day, 2026-11-19).
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
  // A page, not a popup — and the way back keeps the list's filter.
  expect(window.location.pathname).toBe("/control/libraries/gallery");
  expect(window.location.search).toBe("?type=gallery");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens a library's page from a click on its row", async () => {
  const user = userEvent.setup();
  render(<LibrariesSection />);
  await user.click(await screen.findByText("gallery collection"));
  expect(window.location.pathname).toBe("/control/libraries/gallery");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

// The page is four sections (owner, 2026-11-19) — General, Access, Scanning, Advanced —
// each with its settings, one row apiece saying what it is set to, and its own facts.
it("shows a library's own address as its full page: General, Access, Scanning, Advanced, each with its settings and facts", async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, "", "/control/libraries/gallery");
  render(<LibrariesSection libraryId="gallery" />);
  expect(await screen.findByRole("heading", { level: 1, name: "gallery collection" })).toBeInTheDocument();
  // The page, not the list with a popup over it.
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["General", "Access", "Scanning", "Advanced", "Delete library"]);
  expect(screen.getByRole("button", { name: /^Rescan/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Delete library/ })).toBeInTheDocument();

  const titles = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent);
  expect(titles("General")).toEqual(["Name", "Folder", "Organizing"]);
  expect(titles("Access")).toEqual(["Owner and visibility", "Members and groups"]);
  expect(titles("Scanning")).toEqual(["Scan sources", "Back sides", "Face recognition"]);
  expect(titles("Advanced")).toEqual(["Files and uploads", "Phone backups"]);
  // The facts sit in the section they are about.
  expect(within(screen.getByRole("region", { name: "General" })).getByText("Created")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Scanning" })).getByText("Last scanned")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Access" })).getByText("Your role")).toBeInTheDocument();

  const row = (title: string) => screen.getAllByText(title).find((el) => el.tagName === "STRONG")!.closest("li") as HTMLElement;
  // A row says what the setting is now.
  expect(row("Name")).toHaveTextContent("gallery collection");
  expect(row("Owner and visibility")).toHaveTextContent("Public");

  // Each Edit opens that one setting.
  await user.click(within(row("Name")).getByRole("button", { name: "Edit" }));
  let dialog = await screen.findByRole("dialog", { name: "Name" });
  expect(within(dialog).getByLabelText("Library name")).toHaveValue("gallery collection");
  expect(within(dialog).queryByLabelText("Mode")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  // Cancel closes the dialog; the page stays.
  expect(window.location.pathname).toBe("/control/libraries/gallery");

  await user.click(within(row("Files and uploads")).getByRole("button", { name: "Edit" }));
  dialog = await screen.findByRole("dialog", { name: "Files and uploads" });
  expect(within(dialog).getByLabelText("Mode")).toHaveValue("managed");
  expect(within(dialog).queryByLabelText("Library name")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  // Members and groups is the access window.
  await user.click(within(row("Members and groups")).getByRole("button", { name: "Edit" }));
  dialog = await screen.findByRole("dialog", { name: "Access to gallery collection" });
  expect(await within(dialog).findByRole("combobox", { name: "Add people or groups" })).toBeInTheDocument();
});

// Nothing that can be changed hides inside another setting's dialog.
it("gives an audiobook library's every option a row: scanning rules, tag text encoding, progress tracking", async () => {
  const user = userEvent.setup();
  window.history.replaceState({}, "", "/control/libraries/audiobook");
  render(<LibrariesSection libraryId="audiobook" />);
  await screen.findByRole("heading", { level: 1, name: "audiobook collection" });
  const titles = (name: string) => within(screen.getByRole("region", { name })).getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent);
  // Everything about reading the folder is together, under Scanning.
  expect(titles("Scanning")).toEqual(["Scan sources", "Scanning rules", "Tag text encoding"]);
  expect(titles("Advanced")).toEqual(["Files and uploads", "Progress tracking"]);
  const row = (title: string) => within(screen.getByRole("region", { name: "Scanning" })).getByText(title).closest("li") as HTMLElement;
  expect(row("Tag text encoding")).toHaveTextContent("None — leave tags as-is");
  await user.click(within(row("Tag text encoding")).getByRole("button", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Tag text encoding" });
  expect(within(dialog).getByLabelText("Tag text encoding")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Progress tracking")).not.toBeInTheDocument();
});

it("says so when the address is of a library that is not there", async () => {
  window.history.replaceState({}, "", "/control/libraries/nope");
  render(<LibrariesSection libraryId="nope" />);
  expect(await screen.findByRole("link", { name: "Back to Libraries" })).toHaveAttribute("href", "/control/libraries");
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

// Chips over the table, and the side column to its right (owner, 2026-11-19: no
// "At a glance" cards over them).
it("opens on a chip per type and Personal over the table, with where scanning is looked after beside it", async () => {
  window.history.replaceState({}, "", "/control/libraries");
  render(<LibrariesSection />);
  expect(await screen.findByText("gallery collection")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "At a glance" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /^Gallery/ })).toHaveAttribute("aria-pressed", "false");
  const scanning = screen.getByRole("region", { name: "Scanning" });
  expect(within(scanning).getByRole("button", { name: /^Rescan all/ })).toBeInTheDocument();
  expect(within(scanning).getByRole("link", { name: /^Scan schedules/ })).toBeInTheDocument();
  const where = screen.getByRole("region", { name: "Where files live" });
  // The table and the side column are the two halves of one row.
  const table = screen.getByRole("table");
  expect(scanning.closest(".library-overview")).toBe(table.closest(".library-overview"));
  expect(where.closest(".diag-video-side")).toBe(scanning.closest(".diag-video-side"));
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
