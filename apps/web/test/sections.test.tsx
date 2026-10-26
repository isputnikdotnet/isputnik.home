import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The menu's sections (app/sections.ts): the admin's switches on Settings →
// Appearance decide which sections the household sees; a hidden section's
// routes land on Home, and its Tags scope is not offered.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { ALL_SECTIONS_ON, currentSections, rememberSections, resetSections, routeAllowed, useSections } =
  await import("../src/app/sections");
const { AppearanceSection } = await import("../src/features/control/sections/AppearanceSection");
const { getTagScopes } = await import("../src/features/audiobooks/TagListPage");
const mockApi = vi.mocked(api);

function Menu() {
  const sections = useSections();
  return <p data-testid="menu">{Object.entries(sections).filter(([, on]) => on).map(([key]) => key).join(" ")}</p>;
}

beforeEach(() => {
  mockApi.mockReset();
  resetSections();
  rememberSections(ALL_SECTIONS_ON);
});

describe("the sections", () => {
  it("start all on, follow what the server says, and reach every mounted reader", async () => {
    render(<Menu />);
    expect(screen.getByTestId("menu")).toHaveTextContent("audiobooks ebooks gallery familyTree stories games");
    rememberSections({ audiobooks: false, games: false, junk: "ignored" });
    await waitFor(() => expect(screen.getByTestId("menu")).toHaveTextContent("ebooks gallery familyTree stories"));
    expect(currentSections().audiobooks).toBe(false);
  });

  it("close a hidden section's routes, keep the cross-type pages while a book section is on", () => {
    const off = { ...ALL_SECTIONS_ON, audiobooks: false, gallery: false };
    expect(routeAllowed("audiobooks", off)).toBe(false);
    expect(routeAllowed("audiobookPlayer", off)).toBe(false);
    expect(routeAllowed("galleryAlbum", off)).toBe(false);
    expect(routeAllowed("ebooks", off)).toBe(true);
    expect(routeAllowed("authors", off)).toBe(true);
    expect(routeAllowed("home", off)).toBe(true);
    expect(routeAllowed("tags", off)).toBe(true);
    expect(routeAllowed("authors", { ...off, ebooks: false })).toBe(false);
    expect(routeAllowed("profile", { ...off, ebooks: false })).toBe(true);
  });

  it("leave a hidden section's scope out of the Tags page", () => {
    expect(getTagScopes().map((scope) => scope.value)).toEqual(["all", "audiobook", "ebook", "gallery", "family", "story"]);
    rememberSections({ ...ALL_SECTIONS_ON, familyTree: false, stories: false });
    expect(getTagScopes().map((scope) => scope.value)).toEqual(["all", "audiobook", "ebook", "gallery"]);
  });
});

describe("Settings → Appearance → Sections", () => {
  it("saves one switch at a time and tells the menu at once; the last one on cannot go", async () => {
    mockApi.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        const body = JSON.parse(String(options.body)) as { sections: Record<string, boolean> };
        return { config: { defaultTheme: "minimalist", sections: body.sections } };
      }
      return { config: { defaultTheme: "minimalist", sections: { ...ALL_SECTIONS_ON, ebooks: false, gallery: false, familyTree: false, stories: false, games: false, video: false } } };
    });
    render(<><AppearanceSection /><Menu /></>);
    const audiobooks = await screen.findByRole("switch", { name: "Audiobooks" });
    expect(audiobooks).toHaveAttribute("aria-checked", "true");
    // The only section on: its switch is held, so the menu never empties.
    expect(audiobooks).toBeDisabled();

    await userEvent.click(screen.getByRole("switch", { name: "Gallery" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Gallery" })).toHaveAttribute("aria-checked", "true"));
    expect(mockApi).toHaveBeenLastCalledWith("/api/config", expect.objectContaining({ method: "PATCH" }));
    const sent = JSON.parse(String(vi.mocked(api).mock.calls.at(-1)?.[1]?.body)) as { sections: Record<string, boolean> };
    expect(sent.sections).toEqual({ ...ALL_SECTIONS_ON, ebooks: false, familyTree: false, stories: false, games: false, video: false });
    // The menu beside the page learned it without a reload.
    expect(screen.getByTestId("menu")).toHaveTextContent("audiobooks gallery");
    // With two on, either may go now.
    expect(screen.getByRole("switch", { name: "Audiobooks" })).not.toBeDisabled();
  });

  it("puts a switch back when the save fails", async () => {
    mockApi.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (options?.method === "PATCH") throw new Error("Unable to save configuration");
      return { config: { defaultTheme: "minimalist", sections: ALL_SECTIONS_ON } };
    });
    render(<AppearanceSection />);
    const stories = await screen.findByRole("switch", { name: "Stories" });
    await userEvent.click(stories);
    await waitFor(() => expect(screen.getByText("Unable to save configuration")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Stories" })).toHaveAttribute("aria-checked", "true");
    expect(currentSections().stories).toBe(true);
  });
});
