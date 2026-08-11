import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn(), csrfToken: vi.fn(() => "csrf-token") }));

const { api } = await import("../src/api");
const { MusicPicker } = await import("../src/features/gallery/MusicPicker");
const mockApi = vi.mocked(api);

// Uploading music is the one place in this dialog that talks to the server without
// the `api` helper (it posts FormData), so these cover the shape of that request
// and what the dialog does with the answer — in particular that a name already in
// the list is reported as left alone rather than as a failure.

interface Track {
  id: string;
  title: string;
  artist: string | null;
  builtin: boolean;
  durationSeconds: number | null;
  url: string;
  uploadedBy: string | null;
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: "t1",
    title: "Sunset",
    artist: null,
    builtin: false,
    durationSeconds: 62,
    url: "/api/library/gallery/music/t1/stream",
    uploadedBy: "u1",
    ...over
  };
}

/** Stub the upload endpoint with one answer, and report what it was posted. */
function stubUpload(answer: { status?: number; tracks?: Track[]; skipped?: string[] }) {
  const calls: { names: string[]; parts: number }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = init.body as FormData;
    const files = body.getAll("file") as File[];
    calls.push({ names: files.map((f) => f.name), parts: files.length });
    return {
      ok: (answer.status ?? 201) < 400,
      status: answer.status ?? 201,
      json: async () => ({ tracks: answer.tracks ?? [], skipped: answer.skipped ?? [] })
    } as unknown as Response;
  }));
  return calls;
}

function mount(existing: Track[] = []) {
  const onSelect = vi.fn();
  mockApi.mockImplementation(async () => ({ tracks: existing }));
  render(<MusicPicker selectedId={null} onSelect={onSelect} onClose={vi.fn()} />);
  return { onSelect };
}

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

beforeEach(() => {
  mockApi.mockReset();
  vi.unstubAllGlobals();
});

describe("slideshow music picker", () => {
  it("accepts more than one file at a time", async () => {
    mount();
    await waitFor(() => expect(fileInput()).toBeInTheDocument());
    expect(fileInput().multiple).toBe(true);
  });

  it("sends the whole selection in one request", async () => {
    const user = userEvent.setup();
    const calls = stubUpload({ tracks: [track({ id: "a", title: "One" }), track({ id: "b", title: "Two" })] });
    const { onSelect } = mount();
    await waitFor(() => expect(fileInput()).toBeInTheDocument());

    await user.upload(fileInput(), [
      new File(["a"], "One.mp3", { type: "audio/mpeg" }),
      new File(["b"], "Two.mp3", { type: "audio/mpeg" })
    ]);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].names).toEqual(["One.mp3", "Two.mp3"]);
    // The first of a batch is what the slideshow lands on, as a single upload always did.
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("a"));
  });

  it("reports a name already in the list as left alone, not as an error", async () => {
    const user = userEvent.setup();
    stubUpload({ tracks: [track({ id: "a", title: "One" })], skipped: ["Sunset.mp3"] });
    mount([track()]);
    await waitFor(() => expect(fileInput()).toBeInTheDocument());

    await user.upload(fileInput(), [
      new File(["a"], "One.mp3", { type: "audio/mpeg" }),
      new File(["b"], "Sunset.mp3", { type: "audio/mpeg" })
    ]);

    await waitFor(() => expect(screen.getByText("Some tracks were already here")).toBeInTheDocument());
    // The skipped file is named, so it is clear what was left out and why.
    expect(screen.getByText(/left alone: Sunset\.mp3/)).toBeInTheDocument();
    expect(screen.queryByText("Music error")).not.toBeInTheDocument();
  });

  it("still explains a genuine upload failure", async () => {
    const user = userEvent.setup();
    stubUpload({ status: 413, tracks: [], skipped: [] });
    mount();
    await waitFor(() => expect(fileInput()).toBeInTheDocument());

    await user.upload(fileInput(), [new File(["a"], "Huge.mp3", { type: "audio/mpeg" })]);

    await waitFor(() => expect(screen.getByText(/Music error/)).toBeInTheDocument());
  });
});
