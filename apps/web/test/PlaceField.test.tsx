import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaceField, type PlaceLoadResult, type PlaceOption, type PlacePin } from "../src/shared/PlaceField";

// The place field suggests only what its loader finds (real places, with pins),
// keeps whatever is typed, and says so when a search finds nothing — or when
// there is no place list to search at all.

function Harness({ load, searchOnline }: {
  load: (query: string) => Promise<PlaceLoadResult>;
  searchOnline?: (query: string) => Promise<PlaceOption[]>;
}) {
  const [value, setValue] = useState("");
  const [pin, setPin] = useState<PlacePin | null>(null);
  return (
    <>
      <PlaceField
        label="Place"
        value={value}
        pin={pin}
        load={load}
        searchOnline={searchOnline}
        onChange={(text, next) => { setValue(text); setPin(next); }}
      />
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

  // The online lookup: a button, never typeahead — one press, one request.
  const nothing = async () => ({ available: true, options: [] });

  it("offers the online lookup for words the place list does not know", async () => {
    const searchOnline = vi.fn(async (): Promise<PlaceOption[]> => [{
      label: "Ratomka, Minsk District, Minsk Region, 223054, Belarus",
      insert: "Ratomka, Belarus",
      pin: { lat: 53.95, lng: 27.32 },
      kind: "online"
    }]);
    render(<Harness load={nothing} searchOnline={searchOnline} />);
    type("Ratomka");

    const button = await screen.findByRole("button", { name: /Search online for/ });
    expect(searchOnline).not.toHaveBeenCalled(); // not until it is pressed
    fireEvent.click(button);

    // The list shows the full address; the field takes the short form.
    const option = await screen.findByRole("option", { name: "Ratomka, Minsk District, Minsk Region, 223054, Belarus" });
    fireEvent.mouseDown(option);
    expect(searchOnline).toHaveBeenCalledWith("Ratomka");
    expect(state()).toEqual({ value: "Ratomka, Belarus", pin: { lat: 53.95, lng: 27.32 } });
  });

  it("says when the online lookup found nothing either, and keeps the words", async () => {
    render(<Harness load={nothing} searchOnline={async () => []} />);
    type("Zarechye parish");
    fireEvent.click(await screen.findByRole("button", { name: /Search online for/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Nothing found online for “Zarechye parish”"));
    // Asked and answered: the button is not offered again for the same words.
    expect(screen.queryByRole("button", { name: /Search online for/ })).toBeNull();
    expect(state()).toEqual({ value: "Zarechye parish", pin: null });
  });

  it("keeps the words when the online lookup fails", async () => {
    render(<Harness load={nothing} searchOnline={async () => { throw new Error("offline"); }} />);
    type("Somewhere far");
    fireEvent.click(await screen.findByRole("button", { name: /Search online for/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The online search did not answer"));
    expect(state()).toEqual({ value: "Somewhere far", pin: null });
  });

  it("offers nothing online to a field that was given no lookup", async () => {
    render(<Harness load={nothing} />);
    type("Ratomka");
    expect(await screen.findByRole("status")).toHaveTextContent("No town called");
    expect(screen.queryByRole("button", { name: /Search online for/ })).toBeNull();
  });
});
