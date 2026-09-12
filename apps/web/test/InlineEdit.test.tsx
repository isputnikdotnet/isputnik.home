import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { InlineEdit } from "../src/shared/InlineEdit";

// Every heading, standfirst and caption in the story editor is an InlineEdit, and
// every one of them sits on a page where saving ANY field re-reads the whole story
// — so a new `value` arriving while the field is open is the normal case, not the
// exotic one. The draft is therefore seeded when the field opens and left alone
// afterwards; it used to be re-seeded from an effect, which put the server's older
// text back under the cursor.
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [tick, setTick] = useState(0);
  return (
    <>
      <InlineEdit value={value} ariaLabel="Title" onSave={setValue} />
      {/* Stands in for the parent re-reading the story while the field is open. */}
      <button type="button" onClick={() => setValue("From the server")}>reload</button>
      {/* A re-render that changes nothing the field reads. */}
      <button type="button" onClick={() => setTick(tick + 1)}>re-render {tick}</button>
    </>
  );
}

describe("InlineEdit draft", () => {
  it("opens seeded from the current value", async () => {
    render(<Harness initial="Summer 1974" />);
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Summer 1974");
  });

  it("keeps what is being typed when a new value arrives from the server", async () => {
    render(<Harness initial="Summer 1974" />);
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    const field = screen.getByRole("textbox", { name: "Title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Summer 1975");
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Summer 1975");
  });

  it("shows a new value that arrives while it is closed, and seeds the next edit from it", async () => {
    render(<Harness initial="Summer 1974" />);
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByText("From the server")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("From the server");
  });

  it("does not reset the draft on an unrelated re-render", async () => {
    render(<Harness initial="Summer 1974" />);
    await userEvent.click(screen.getByRole("button", { name: "Title" }));
    const field = screen.getByRole("textbox", { name: "Title" });
    await userEvent.type(field, " revisited");
    fireEvent.click(screen.getByRole("button", { name: /re-render/ }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Summer 1974 revisited");
  });
});
