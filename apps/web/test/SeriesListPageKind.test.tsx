import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
vi.mock("../src/app/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));
vi.mock("../src/router", () => ({
  navigate: vi.fn(),
  queryParam: () => null,
  replaceQuery: vi.fn()
}));

const { api } = await import("../src/api");
const { SeriesListPage } = await import("../src/features/audiobooks/SeriesListPage");
const mockApi = vi.mocked(api);

// Audiobooks › Series and Ebooks › Series are the same component with a different
// `kind`, and App renders them in the same slot — so React keeps the instance and
// only the prop changes. The page has to notice: loading once on mount left the
// Ebooks page showing the audiobook series, and the other way round.

const SERIES = {
  audiobook: { id: "s-audio", name: "The Long Earth", description: null, bookCount: 5, alphaKey: "T", sortKey: "LONG EARTH" },
  ebook: { id: "s-ebook", name: "Discworld", description: null, bookCount: 41, alphaKey: "D", sortKey: "DISCWORLD" }
};

const paths: string[] = [];

beforeEach(() => {
  paths.length = 0;
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string) => {
    paths.push(path);
    if (path === "/api/library/audiobook-libraries") return { libraries: [{ id: "lib-a", name: "Listening", type: "audiobook" }] };
    if (path === "/api/library/ebook-libraries") return { libraries: [{ id: "lib-e", name: "Reading", type: "ebook" }] };
    if (path === "/api/library/audiobook-libraries/lib-a/series") return { series: [SERIES.audiobook] };
    if (path === "/api/library/ebook-libraries/lib-e/series") return { series: [SERIES.ebook] };
    throw new Error(`unexpected ${path}`);
  });
});

describe("Series browse across media types", () => {
  it("reloads for the other media type when the same page is reused", async () => {
    const { rerender } = render(<SeriesListPage kind="ebook" />);
    await screen.findByText("Discworld");
    expect(paths).toContain("/api/library/ebook-libraries");

    // Same slot in App's route switch: the component instance is kept.
    rerender(<SeriesListPage kind="audiobook" />);

    await screen.findByText("The Long Earth");
    expect(paths).toContain("/api/library/audiobook-libraries");
    await waitFor(() => expect(screen.queryByText("Discworld")).not.toBeInTheDocument());
  });
});
