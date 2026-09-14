import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VillageCountries } from "../src/features/control/sections/maps/VillageCountries";
import type { PlacesView } from "../src/features/control/sections/maps/map-settings";

// "Every village in…": a draft of countries that is only sent on Save, and a line
// saying what the current place list holds.

const places = (over: Partial<PlacesView> = {}): PlacesView => ({
  present: true,
  sizeBytes: 27_000_000,
  builtAt: "2026-09-14T10:00:00.000Z",
  sourceDate: null,
  places: 235_000,
  villages: 0,
  villageCountries: [],
  villageCountriesWanted: [],
  countries: ["BY", "UA", "RU"],
  build: { running: false, jobId: null, stage: null, done: 0, total: 0, error: null, finishedAt: null },
  ...over
});

describe("VillageCountries", () => {
  it("adds and removes countries in a draft, and saves only when asked", () => {
    const onSave = vi.fn();
    render(<VillageCountries places={places()} disabled={false} onSave={onSave} />);
    expect(screen.getByText("No countries added.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and rebuild" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Add a country…" }), { target: { value: "BY" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Add a country…" }), { target: { value: "UA" } });
    // Added countries leave the list.
    expect(screen.queryByRole("option", { name: "Belarus" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ukraine" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and rebuild" }));
    expect(onSave).toHaveBeenCalledWith(["BY"]);
  });

  it("says how many villages the place list holds, and when a choice is not built yet", () => {
    const { rerender } = render(
      <VillageCountries places={places({ villages: 12345, villageCountries: ["BY"], villageCountriesWanted: ["BY"] })} disabled={false} onSave={() => {}} />
    );
    expect(screen.getByText("12,345 villages from Belarus")).toBeInTheDocument();

    rerender(<VillageCountries places={places({ villageCountriesWanted: ["UA"] })} disabled={false} onSave={() => {}} />);
    expect(screen.getByText(/Not in the place list yet/)).toBeInTheDocument();
  });
});
