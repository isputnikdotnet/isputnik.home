import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { controlHref } from "../src/router";
import { RecognitionSection } from "../src/features/control/sections/RecognitionSection";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

// Applications › Gallery › Recognition: face recognition and search by content on
// one page, since they share an engine and a nightly window. What belongs to one
// library is on that library's page; this page links there.

function sceneFixture() {
  return {
    enabled: false,
    model: "siglip-base-patch16-224-q8/1",
    engine: { available: true, version: "0.2.0" as string | null, reason: null as string | null },
    libraries: [
      { id: "fam", name: "Family", personal: false, photos: 1200, described: 0, unreadable: 0 },
      { id: "old", name: "Scans", personal: false, photos: 300, described: 0, unreadable: 0 },
      { id: "mum", name: "Mum's library", personal: true, photos: 40, described: 0, unreadable: 0 },
      { id: "dad", name: "Dad's library", personal: true, photos: 10, described: 0, unreadable: 0 }
    ],
    scan: null as null | { libraryId: string; status: "pending" | "running"; processed: number; total: number; queued: number }
  };
}
function facesFixture() {
  return {
    threshold: 0.3,
    groupingStrength: 6,
    libraries: [
      { id: "fam", name: "Family", enabled: true, photos: 1200, scanned: 900, unreadable: 0 },
      { id: "old", name: "Scans", enabled: false, photos: 300, scanned: 0, unreadable: 0 }
    ]
  };
}
let scene = sceneFixture();
let faces = facesFixture();
let engine = { where: "container" as "container" | "none", version: "0.2.0" as string | null, model: "buffalo_l/w600k_r50", gpu: false, reason: null as string | null };
let calls: { method: string; path: string; body: unknown }[] = [];
const health = {
  totalPeople: 12, peopleWithTwin: 2, mergeLine: 0.6,
  bands: { nearCertain: 1, likely: 0, possible: 0 },
  pairs: [{ a: { id: "p1", name: "Mama", faceCount: 40, coverUrl: null }, b: { id: "p2", name: "", faceCount: 3, coverUrl: null }, similarity: 0.71 }]
};

beforeEach(() => {
  window.history.replaceState({}, "", controlHref("recognition"));
  scene = sceneFixture();
  faces = facesFixture();
  engine = { where: "container", version: "0.2.0", model: "buffalo_l/w600k_r50", gpu: false, reason: null };
  calls = [];
  mockApi.mockReset();
  mockApi.mockImplementation(async (path, options) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (method !== "GET") calls.push({ method, path, body });
    if (path === "/api/library/gallery/scene/settings" && method === "GET") return scene;
    if (path === "/api/library/gallery/scene/settings" && method === "PATCH") {
      if (body.enabled && !scene.engine.available) throw new Error(scene.engine.reason ?? "no engine");
      scene = { ...scene, enabled: body.enabled };
      return scene;
    }
    if (path === "/api/library/gallery/scene/scan") return { jobs: 2, ...scene };
    if (path === "/api/library/gallery/scene/data") {
      scene = { ...scene, libraries: scene.libraries.map((library) => ({ ...library, described: 0 })) };
      return { removed: 1500, ...scene };
    }
    if (path === "/api/library/gallery/faces/settings" && method === "GET") return faces;
    if (path === "/api/library/gallery/faces/settings" && method === "PATCH") {
      if (body.libraryId) faces = { ...faces, libraries: faces.libraries.map((library) => (library.id === body.libraryId ? { ...library, enabled: body.enabled } : library)) };
      return faces;
    }
    if (path === "/api/library/gallery/faces/recompute") return { job: "j1" };
    if (path === "/api/library/gallery/faces/engine") return engine;
    if (path === "/api/library/gallery/faces/cluster-health") return health;
    if (path === "/api/library/gallery/people/p2/merge") return {};
    if (path === "/api/scheduled-jobs") return { jobs: [
      { key: "backup_full", label: "Full backup", enabled: true, time: "01:00" },
      { key: "scan_new_scenes", label: "Describe new photos for search", enabled: false, time: "05:30" },
      { key: "scan_new_faces", label: "Scan new photos for faces", enabled: true, time: "05:00" }
    ] };
    throw new Error(`Unexpected API call: ${method} ${path}`);
  });
});

const part = (name: string | RegExp) => screen.findByRole("region", { name });

describe("Recognition (control panel)", () => {
  it("opens at a glance: the engine, face recognition and search by content, each with its state", async () => {
    render(<RecognitionSection />);
    const glance = await part("At a glance");
    await waitFor(() => expect(glance).toHaveTextContent("Version 0.2.0"));
    expect(glance).toHaveTextContent(/Recognition engine\s*Ready/);
    expect(glance).toHaveTextContent(/Face recognition\s*On\s*Libraries on: 1 of 2/);
    expect(glance).toHaveTextContent(/Search by content\s*Off\s*Described: 0 of 1,550/);
  });

  it("is one column of sections, with what the two share beside them", async () => {
    render(<RecognitionSection />);
    await part("Face recognition");
    const main = document.querySelector(".diag-video-main") as HTMLElement;
    expect(within(main).getAllByRole("region").map((region) => region.getAttribute("aria-label")
      ?? document.getElementById(region.getAttribute("aria-labelledby") ?? "")?.textContent))
      .toEqual(["At a glance", "Face recognition", "Search by content"]);
    // A household can have many libraries: none is listed on the page itself.
    expect(within(main).queryByText("Family")).toBeNull();
    expect(within(main).queryAllByRole("switch")).toHaveLength(1);
    // The layout of Gallery's Settings page, not a grid of cards.
    expect(document.querySelector(".settings-card-grid")).toBeNull();
    const side = document.querySelector(".diag-video-side") as HTMLElement;
    expect(within(side).getByRole("region", { name: "Recognition engine" })).toBeInTheDocument();
    expect(within(side).getByRole("region", { name: "Nightly schedule" })).toBeInTheDocument();
  });

  it("keeps face recognition's three settings together: libraries, grouping strength and the people check", async () => {
    render(<RecognitionSection />);
    const section = await part("Face recognition");
    await waitFor(() => expect(within(section).getByRole("button", { name: /^Libraries/ })).toHaveTextContent(/1 of 2$/));
    expect(within(section).getAllByRole("button").map((row) => row.querySelector("strong")!.textContent))
      .toEqual(["Libraries", "Grouping strength", "People check"]);
  });

  it("switches libraries on and off in a popup, and leaves the app's own libraries off the list", async () => {
    faces.libraries.push({ id: "inbox", name: "Photo Inbox", enabled: false, photos: 3, scanned: 0, unreadable: 0 });
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Face recognition");
    await user.click(await within(section).findByRole("button", { name: /^Libraries/ }));
    const dialog = screen.getByRole("dialog", { name: "Face recognition by library" });
    const family = within(dialog).getByRole("switch", { name: /^Family/ });
    expect(family).toHaveAttribute("aria-checked", "true");
    expect(family).toHaveTextContent(/900 of 1,?200/);
    const scans = within(dialog).getByRole("switch", { name: /^Scans/ });
    expect(scans).toHaveAttribute("aria-checked", "false");
    // Not the Photo Inbox: it is never scanned for faces, whatever a switch says.
    expect(within(dialog).queryByRole("switch", { name: /Photo Inbox/ })).toBeNull();
    expect(within(dialog).getAllByRole("switch")).toHaveLength(2);

    await user.click(scans);
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: /^Scans/ })).toHaveAttribute("aria-checked", "true"));
    expect(calls).toEqual([{ method: "PATCH", path: "/api/library/gallery/faces/settings", body: { libraryId: "old", enabled: true } }]);
    // The popup stays open for the next library, and the page behind it counts both.
    expect(screen.getByRole("dialog", { name: "Face recognition by library" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(section).getByRole("button", { name: /^Libraries/ })).toHaveTextContent(/2 of 2$/));
  });

  it("will not switch a library on with no engine, and still lets one be switched off", async () => {
    engine = { where: "none", version: null, model: "", gpu: false, reason: "Face recognition needs the isputnik.faces container." };
    scene.engine = { available: false, version: null, reason: "not paired" };
    const user = userEvent.setup();
    render(<RecognitionSection />);
    expect(await screen.findByText("The recognition engine is not available")).toBeInTheDocument();
    const section = await part("Face recognition");
    await user.click(await within(section).findByRole("button", { name: /^Libraries/ }));
    const dialog = screen.getByRole("dialog", { name: "Face recognition by library" });
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: /^Scans/ })).toBeDisabled());
    expect(within(dialog).getByRole("switch", { name: /^Family/ })).toBeEnabled();
  });

  it("keeps the grouping strength in a popup, with Regroup people inside it", async () => {
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Face recognition");
    // On the page it is one row saying what it is set to: no slider across the page.
    const row = await within(section).findByRole("button", { name: /^Grouping strength/ });
    await waitFor(() => expect(row).toHaveTextContent(/6$/));
    expect(within(section).queryByRole("slider")).toBeNull();

    await user.click(row);
    const dialog = screen.getByRole("dialog", { name: "Grouping strength" });
    expect(within(dialog).getByRole("slider")).toHaveValue("6");
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: /group/i }));
    await waitFor(() => expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PATCH /api/library/gallery/faces/settings", "POST /api/library/gallery/faces/recompute"
    ]));
    expect(calls[0].body).toEqual({ groupingStrength: 6 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("runs the people check when its popup is opened, not before, and merges a suggested pair", async () => {
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Face recognition");
    const row = await within(section).findByRole("button", { name: /^People check/ });
    await waitFor(() => expect(row).toBeEnabled());
    expect(mockApi.mock.calls.some(([path]) => path === "/api/library/gallery/faces/cluster-health")).toBe(false);

    await user.click(row);
    const dialog = screen.getByRole("dialog", { name: "People check" });
    expect(await within(dialog).findByText(/Mama/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Merge/ }));
    await waitFor(() => expect(calls).toEqual([{ method: "POST", path: "/api/library/gallery/people/p2/merge", body: { intoId: "p1" } }]));
    await waitFor(() => expect(within(dialog).queryByText(/Mama/)).toBeNull());
  });

  it("switches search by content on with one switch for every library, and then offers a scan", async () => {
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Search by content");
    const toggle = await within(section).findByRole("switch", { name: /Describe photos for search/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(within(section).getAllByRole("switch")).toHaveLength(1);
    expect(within(section).queryByRole("button", { name: /^Scan photos/ })).toBeNull();
    await user.click(toggle);
    await waitFor(() => expect(within(section).getByRole("switch")).toHaveAttribute("aria-checked", "true"));
    expect(calls).toEqual([{ method: "PATCH", path: "/api/library/gallery/scene/settings", body: { enabled: true } }]);
    // One row for scanning, saying how much is waiting.
    expect(within(section).getByRole("button", { name: /^Scan photos/ })).toHaveTextContent("Not described yet: 1,550");
  });

  it("says how far search has got in one row, with each library in a popup and personal libraries counted together", async () => {
    scene.enabled = true;
    scene.libraries[0].described = 1200;
    scene.libraries[1] = { ...scene.libraries[1], described: 298, unreadable: 2 };
    scene.scan = { libraryId: "old", status: "running", processed: 298, total: 300, queued: 0 };
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Search by content");
    expect(await within(section).findByRole("link", { name: /Scan in progress/ })).toHaveTextContent("298 of 300");
    // No second scan while one runs.
    expect(within(section).getByRole("button", { name: /^Scan photos/ })).toBeDisabled();
    const row = within(section).getByRole("button", { name: /^Progress by library/ });
    expect(row).toHaveTextContent(/1,498 of 1,550$/);
    expect(within(section).queryByText("Family")).toBeNull();

    await user.click(row);
    const dialog = screen.getByRole("dialog", { name: "Photos described" });
    expect(within(dialog).getByText("Family").closest(".grouped-row")).toHaveTextContent("1,200 of 1,200");
    expect(within(dialog).getByText("Could not be read: 2").closest(".grouped-row")).toHaveTextContent("298 of 300");
    expect(within(dialog).getByText("Personal libraries: 2").closest(".grouped-row")).toHaveTextContent("0 of 50");
    expect(within(dialog).queryByText("Mum's library")).toBeNull();
  });

  it("scans from one popup: only what is new, or everything again", async () => {
    scene.enabled = true;
    scene.libraries[0].described = 1200;
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Search by content");
    await user.click(await within(section).findByRole("button", { name: /^Scan photos/ }));
    const dialog = screen.getByRole("dialog", { name: "Scan photos for search" });
    const onlyNew = within(dialog).getByRole("radio", { name: /^Only what is new/ });
    const everything = within(dialog).getByRole("radio", { name: /^Everything again/ });
    // 350 photos are still waiting, so "only what is new" is the choice offered first.
    expect(onlyNew).toBeChecked();
    expect(onlyNew).toHaveTextContent("Not described yet: 350");
    expect(everything).toHaveTextContent("All 1,550 photos");
    expect(calls).toEqual([]);

    await user.click(everything);
    await user.click(within(dialog).getByRole("button", { name: "Start scan" }));
    await waitFor(() => expect(calls).toEqual([{ method: "POST", path: "/api/library/gallery/scene/scan", body: { force: true } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers only everything again once nothing is waiting", async () => {
    scene.enabled = true;
    scene.libraries = scene.libraries.map((library) => ({ ...library, described: library.photos }));
    const user = userEvent.setup();
    render(<RecognitionSection />);
    const section = await part("Search by content");
    const row = await within(section).findByRole("button", { name: /^Scan photos/ });
    expect(row).toHaveTextContent("Every photo is described");
    await user.click(row);
    const dialog = screen.getByRole("dialog", { name: "Scan photos for search" });
    expect(within(dialog).getByRole("radio", { name: /^Only what is new/ })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /^Everything again/ })).toBeChecked();
  });

  it("asks before deleting search data, and offers it only once switched off", async () => {
    scene.libraries[0].described = 1200;
    const user = userEvent.setup();
    render(<RecognitionSection />);
    await user.click(await screen.findByRole("button", { name: "Delete search data" }));
    const gone = screen.getByRole("alertdialog", { name: "Delete search data?" });
    expect(calls).toEqual([]);
    await user.click(within(gone).getByRole("button", { name: "Delete search data" }));
    await waitFor(() => expect(calls).toEqual([{ method: "DELETE", path: "/api/library/gallery/scene/data", body: undefined }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete search data" })).toBeNull());
  });

  it("says once what the engine can do, and warns when it is too old to describe photos", async () => {
    scene.engine = { available: false, version: "0.1.1", reason: "The isputnik.faces container is older than 0.2.0 and cannot describe photos yet: update it." };
    render(<RecognitionSection />);
    expect(await screen.findByText("The recognition engine is not available")).toBeInTheDocument();
    expect(screen.getAllByText(/older than 0\.2\.0/)).toHaveLength(1);
    const engineList = await part("Recognition engine");
    expect(within(engineList).getByText("Finding faces").closest(".grouped-row")).toHaveTextContent("Ready");
    expect(within(engineList).getByText("Describing photos").closest(".grouped-row")).toHaveTextContent("Not available");
  });

  it("lists the two nightly jobs in the order they run, each leading to Scheduled jobs", async () => {
    render(<RecognitionSection />);
    const schedule = await part("Nightly schedule");
    await waitFor(() => expect(within(schedule).getAllByRole("link")).toHaveLength(2));
    const [first, second] = within(schedule).getAllByRole("link");
    expect(first).toHaveTextContent(/Scan new photos for faces\s*05:00/);
    expect(second).toHaveTextContent(/Describe new photos for search\s*Off/);
    expect(second).toHaveAttribute("href", controlHref("scheduledJobs"));
  });

  it("still shows search when face settings cannot be read, and says so", async () => {
    const base = mockApi.getMockImplementation()!;
    mockApi.mockImplementation(async (path, options) => {
      if (path === "/api/library/gallery/faces/settings") throw new Error("Face settings are away");
      return base(path, options);
    });
    render(<RecognitionSection />);
    expect(await screen.findByText("Face settings are away")).toBeInTheDocument();
    const section = await part("Search by content");
    expect(within(section).getByRole("switch", { name: /Describe photos for search/ })).toBeInTheDocument();
  });
});
