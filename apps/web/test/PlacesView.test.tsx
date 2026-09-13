import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));

const { api } = await import("../src/api");
const { PlacesView } = await import("../src/features/gallery/page/PlacesView");
const mockApi = vi.mocked(api);

// The gallery's Places view (docs/map-approach-proposal.md, phase 2): places grouped
// by country, countries in order of how many photos were taken there, the search
// box narrowing by town, region or country, and a place opening as a filter.

const place = (id: number, name: string, region: string | null, country: string, countryCode: string, count: number) => ({
  id, name, region, country, countryCode, count, cover: { coverUrl: `/covers/${id}.jpg`, faceFocus: null }
});

const PLACES = [
  place(3173435, "Milan", "Lombardy", "Italy", "IT", 13),
  place(2643743, "London", "England", "United Kingdom", "GB", 9),
  place(3169070, "Rome", "Lazio", "Italy", "IT", 6)
];

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockResolvedValue({ places: PLACES });
});

describe("the Places view", () => {
  it("groups places by country, the most photographed country first, and asks for the libraries in scope", async () => {
    render(<PlacesView scopeQuery="libraryIds=GAL" nameTerm="" onOpen={() => {}} onCount={() => {}} />);
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([expect.stringContaining("Italy"), expect.stringContaining("United Kingdom")]);
    const italy = headings[0].closest("section") as HTMLElement;
    expect(within(italy).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining("Milan"),
      expect.stringContaining("Rome")
    ]);
    expect(within(italy).getByText("19 photos")).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/library/gallery/places?libraryIds=GAL");
  });

  it("narrows by the search box, says how many are shown, and opens a place", async () => {
    const onOpen = vi.fn();
    const onCount = vi.fn();
    const { rerender } = render(<PlacesView scopeQuery="" nameTerm="" onOpen={onOpen} onCount={onCount} />);
    await screen.findByText("Milan");
    expect(onCount).toHaveBeenLastCalledWith(3);

    rerender(<PlacesView scopeQuery="" nameTerm="lazio" onOpen={onOpen} onCount={onCount} />);
    expect(screen.queryByText("Milan")).toBeNull();
    expect(onCount).toHaveBeenLastCalledWith(1);

    await userEvent.setup().click(screen.getByRole("button", { name: /Rome/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 3169070 }));
  });

  it("explains an empty list rather than showing nothing", async () => {
    mockApi.mockResolvedValue({ places: [] });
    render(<PlacesView scopeQuery="" nameTerm="" onOpen={() => {}} onCount={() => {}} />);
    expect(await screen.findByText("No named places yet")).toBeInTheDocument();
  });
});
