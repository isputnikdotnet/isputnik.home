import { act, render, screen, waitFor } from "@testing-library/react";
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
    if (path.includes("-libraries")) {
      const type = path.split("/").at(-1)!.split("-libraries")[0];
      return { libraries: [{ id: type, name: `${type} collection`, type, createdAt: "2026-01-01", scanStatus: "idle", lastScannedAt: null,
        visibility: "public", ownerId: null, ownerType: null, canManageLibrary: true, fileCount: 1, totalSizeBytes: 1024 }] };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

it("opens with only the linked application's libraries and preserves the filter in Manage links", async () => {
  render(<LibrariesSection />);
  await screen.findByText("gallery collection");
  expect(screen.queryByText("ebook collection")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Manage gallery collection/i })).toHaveAttribute("href", "/control/libraries/gallery?type=gallery");
});

it("lets the user show all types, keeps that choice in the URL, and restores Back", async () => {
  render(<LibrariesSection />);
  await screen.findByText("gallery collection");
  const filter = document.querySelector<HTMLButtonElement>(".library-type-filter button")!;
  await userEvent.click(filter);
  await userEvent.click(screen.getByRole("option", { name: /All/ }));
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
