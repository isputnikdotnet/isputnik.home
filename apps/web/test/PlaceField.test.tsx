import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaceField, type PlaceLoadResult, type PlacePin } from "../src/shared/PlaceField";

// The place field suggests only what its loader finds (real places, with pins),
// keeps whatever is typed, and says so when a search finds nothing — or when
// there is no place list to search at all.

function Harness({ load }: { load: (query: string) => Promise<PlaceLoadResult> }) {
  const [value, setValue] = useState("");
  const [pin, setPin] = useState<PlacePin | null>(null);
  return (
    <>
      <PlaceField label="Place" value={value} pin={pin} load={load} onChange={(text, next) => { setValue(text); setPin(next); }} />
      <pre data-testid="state">{JSON.stringify({ value, pin })}</pre>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");
const type = (text: string) => fireEvent.change(screen.getByRole("combobox", { name: "Place" }), { target: { value: text } });

describe("PlaceField", () => {
  it("picks a found town with its pin", async () => {
    const load = vi.fn(async () => ({ available: true, options: [{ label: "Minsk, Belarus", pin: { lat: 53.9, lng: 27.56 }, kind: "town" as const }] }));
    render(<Harness load={load} />);
    type("Mins");
    const option = await screen.findByRole("option", { name: "Minsk, Belarus" });
    fireEvent.mouseDown(option);
    expect(state()).toEqual({ value: "Minsk, Belarus", pin: { lat: 53.9, lng: 27.56 } });
  });

  it("keeps typed words that match nothing, and says so", async () => {
    render(<Harness load={async () => ({ available: true, options: [] })} />);
    type("Veselovka");
    expect(await screen.findByRole("status")).toHaveTextContent("No town called “Veselovka” in the place list");
    expect(state()).toEqual({ value: "Veselovka", pin: null });
  });

  it("says when there is no place list to search", async () => {
    render(<Harness load={async () => ({ available: false, options: [] })} />);
    type("Veselovka");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("There is no place list to search yet"));
  });
});
