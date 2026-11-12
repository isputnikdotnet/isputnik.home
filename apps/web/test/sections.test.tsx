import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The menu's sections (app/sections.ts): the admin's switches on each application's
// Setup tab decide which sections the household sees; a hidden section's
// routes land on Home, and its Tags scope is not offered.

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

const { api } = await import("../src/api");
const { ALL_SECTIONS_ON, currentSections, rememberSections, resetSections, routeAllowed, useSections } =
  await import("../src/app/sections");
const { AppSetupSection } = await import("../src/features/control/sections/AppSetupSection");
const { resetApplicationsCache } = await import("../src/features/control/applications");
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

// The switches were Settings › Appearance › Sections until control panel v2; each
// application's Setup tab now holds its own.
describe("an application's Setup › In the menu", () => {
  const ONLY_AUDIOBOOKS = { ...ALL_SECTIONS_ON, ebooks: false, gallery: false, familyTree: false, stories: false, games: false, video: false };

  function serve(sections: Record<string, boolean>, patch: (body: { sections: Record<string, boolean> }) => unknown) {
    mockApi.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === "/api/config" && options?.method === "PATCH") return patch(JSON.parse(String(options.body)));
      if (path === "/api/config") return { config: { defaultTheme: "minimalist", sections } };
      if (path === "/api/apps/admin/status") return { apps: [] };
      if (path.includes("-libraries")) return { libraries: [] };
      throw new Error("not served");
    });
  }

  beforeEach(() => resetApplicationsCache());

  it("holds the last application that is on, so the menu never empties", async () => {
    serve(ONLY_AUDIOBOOKS, (body) => ({ config: body }));
    render(<AppSetupSection app="audiobooks" />);
    const audiobooks = await screen.findByRole("switch", { name: "Show Audiobooks in the menu" });
    expect(audiobooks).toHaveAttribute("aria-checked", "true");
    expect(audiobooks).toBeDisabled();
  });

  it("saves the switch and tells the menu at once", async () => {
    serve(ONLY_AUDIOBOOKS, (body) => ({ config: { defaultTheme: "minimalist", sections: body.sections } }));
    render(<><AppSetupSection app="gallery" /><Menu /></>);
    const gallery = await screen.findByRole("switch", { name: "Show Gallery in the menu" });
    expect(gallery).toHaveAttribute("aria-checked", "false");

    await userEvent.click(gallery);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show Gallery in the menu" })).toHaveAttribute("aria-checked", "true"));
    expect(mockApi).toHaveBeenLastCalledWith("/api/config", expect.objectContaining({ method: "PATCH" }));
    const sent = JSON.parse(String(vi.mocked(api).mock.calls.at(-1)?.[1]?.body)) as { sections: Record<string, boolean> };
    expect(sent.sections).toEqual({ ...ONLY_AUDIOBOOKS, gallery: true });
    // The menu beside the page learned it without a reload.
    expect(screen.getByTestId("menu")).toHaveTextContent("audiobooks gallery");
  });

  it("puts a switch back when the save fails", async () => {
    serve(ALL_SECTIONS_ON, () => { throw new Error("Unable to save configuration"); });
    render(<AppSetupSection app="stories" />);
    const stories = await screen.findByRole("switch", { name: "Show Stories in the menu" });
    await userEvent.click(stories);
    await waitFor(() => expect(screen.getByText("Unable to save configuration")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Show Stories in the menu" })).toHaveAttribute("aria-checked", "true");
    expect(currentSections().stories).toBe(true);
  });
});
