import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PartialDateInput } from "../src/shared/PartialDateInput";

// Day · Month · Year over the partial ISO value: a year alone is a whole date, a
// month and a day narrow it, and a half-given date is flagged on the part to fix
// instead of being trimmed into a different date.

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PartialDateInput label="Date" value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

const day = () => screen.getByRole("textbox", { name: "Day" }) as HTMLInputElement;
const month = () => screen.getByRole("combobox", { name: "Month" }) as HTMLSelectElement;
const year = () => screen.getByRole("textbox", { name: "Year" }) as HTMLInputElement;
const value = () => screen.getByTestId("value").textContent;

describe("PartialDateInput", () => {
  it("reads a stored date into its parts", () => {
    render(<Harness initial="1924-05-07" />);
    expect(day().value).toBe("7");
    expect(month().value).toBe("5");
    expect(year().value).toBe("1924");
  });

  it("builds year, year-month and full dates as parts are filled", () => {
    render(<Harness />);
    fireEvent.change(year(), { target: { value: "1924" } });
    expect(value()).toBe("1924");
    fireEvent.change(month(), { target: { value: "5" } });
    expect(value()).toBe("1924-05");
    fireEvent.change(day(), { target: { value: "7" } });
    expect(value()).toBe("1924-05-07");
    fireEvent.change(year(), { target: { value: "" } });
    fireEvent.change(month(), { target: { value: "" } });
    fireEvent.change(day(), { target: { value: "" } });
    expect(value()).toBe("");
  });

  it("flags a day without a month, a missing year and an impossible day", () => {
    render(<Harness initial="1924" />);
    fireEvent.change(day(), { target: { value: "12" } });
    expect(month().validationMessage).not.toBe("");
    expect(value()).toBe("1924--12");

    fireEvent.change(month(), { target: { value: "4" } });
    expect(month().validationMessage).toBe("");
    fireEvent.change(day(), { target: { value: "31" } });
    expect(day().validationMessage).not.toBe("");

    fireEvent.change(day(), { target: { value: "30" } });
    expect(day().validationMessage).toBe("");
    fireEvent.change(year(), { target: { value: "" } });
    expect(year().validationMessage).not.toBe("");
  });
});
