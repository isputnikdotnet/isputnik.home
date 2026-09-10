import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordAudioModal } from "../src/shared/audio/RecordAudioModal";

// jsdom has no microphone, no MediaRecorder and no media pipeline. The upload
// path needs none of them, so it is the one exercised here: a picked file
// becomes the take, is listened back to, and only Save hands it on.
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:take") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  // The wave strip draws on a canvas; jsdom has none, and says so loudly without this.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
});

const file = () => new File([new Uint8Array([1, 2, 3])], "grandma.wav", { type: "audio/wav" });

describe("RecordAudioModal", () => {
  it("offers only Cancel and a disabled Save until there is a take", () => {
    render(<RecordAudioModal title="Add narration" maxSeconds={60} allowUpload onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByText("Upload a recording")).toBeInTheDocument();
  });

  it("turns an uploaded file into a take, and hands it on only when Save is pressed", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RecordAudioModal title="Add narration" maxSeconds={60} allowUpload onSave={onSave} onClose={onClose} />);

    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
    expect(screen.getByText("grandma.wav")).toBeInTheDocument();
    expect(screen.getByText("Listen back, then save it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ ext: "wav", fileName: "grandma.wav" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("asks before a take is discarded, and keeps it when the answer is no", async () => {
    const onClose = vi.fn();
    render(<RecordAudioModal title="Add narration" maxSeconds={60} allowUpload onSave={vi.fn()} onClose={onClose} />);
    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const ask = screen.getByRole("alertdialog");
    expect(ask).toHaveTextContent("Discard this recording?");
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("grandma.wav")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Discard" }).at(-1)!);
    expect(screen.queryByText("grandma.wav")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows what went wrong when saving fails, and keeps the take", async () => {
    render(<RecordAudioModal title="Add narration" maxSeconds={60} allowUpload onSave={vi.fn().mockRejectedValue(new Error("No room left"))} onClose={vi.fn()} />);
    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("No room left")).toBeInTheDocument();
    expect(screen.getByText("grandma.wav")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
