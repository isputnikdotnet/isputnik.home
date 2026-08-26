import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxRow, type InboxCard } from "../src/features/social/InboxRow";
import { ActivityList, type ActivityItem } from "../src/features/social/ActivityList";

// Two small renderers whose whole job is saying the right words. Both had bugs
// that only showed up against real data, so the words are pinned here.

const card = (over: Partial<InboxCard> = {}): InboxCard => ({
  id: "r1",
  entityType: "audiobook",
  entityId: "b1",
  message: null,
  status: "new",
  createdAt: new Date().toISOString(),
  fromName: "Dad",
  available: true,
  title: "The Hobbit",
  subtitle: "Tolkien",
  coverUrl: null,
  href: "/audiobooks/books/b1",
  savable: true,
  ...over
});

describe("a card in Waiting for you", () => {
  it("says what is being asked, not that an event occurred", () => {
    render(<InboxRow card={card()} busy={false} onAct={vi.fn()} />);
    expect(screen.getByText("Dad wants you to listen to this")).toBeInTheDocument();
  });

  it("offers Like by name, because that is what pressing it does", () => {
    render(<InboxRow card={card()} busy={false} onAct={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Like/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Not now/ })).toBeInTheDocument();
  });

  it("offers a single Done for something with nowhere to be saved to", () => {
    // An album, a slideshow and a person are not library items: there is no
    // Like for them, and "Not now" reads wrong once you have looked.
    render(<InboxRow card={card({ entityType: "gallery_album", savable: false })} busy={false} onAct={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Like/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Done/ })).toBeInTheDocument();
  });

  it("offers no Like for something that is no longer available", () => {
    render(<InboxRow card={card({ available: false })} busy={false} onAct={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Like/ })).not.toBeInTheDocument();
    expect(screen.getByText(/isn’t available to you any more/)).toBeInTheDocument();
  });

  it("shows the sender's own line when they wrote one", () => {
    render(<InboxRow card={card({ message: "stay with it" })} busy={false} onAct={vi.fn()} />);
    expect(screen.getByText(/stay with it/)).toBeInTheDocument();
  });

  it("does not link a card whose subject has gone", () => {
    render(<InboxRow card={card({ available: false, href: "" })} busy={false} onAct={vi.fn()} />);
    expect(screen.getByText("The Hobbit").tagName).toBe("SPAN");
  });

  it("reports which decision was pressed", async () => {
    const user = userEvent.setup();
    const onAct = vi.fn();
    render(<InboxRow card={card()} busy={false} onAct={onAct} />);

    await user.click(screen.getByRole("button", { name: /Like/ }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), "save");

    await user.click(screen.getByRole("button", { name: /Not now/ }));
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), "dismiss");
  });
});

const activity = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "note:n1",
  kind: "note",
  actorName: "Anna",
  createdAt: new Date().toISOString(),
  body: null,
  title: "Dune",
  subtitle: null,
  coverUrl: null,
  href: "/ebooks/books/b1",
  ...over
});

describe("Around the house", () => {
  it("reads as a sentence, with the title in the middle where it belongs", () => {
    // The first version put the title last in every line, which produced
    // "Dad added to the family tree Grandma".
    const { container } = render(<ActivityList items={[activity({ kind: "person", actorName: "Dad", title: "Grandma" })]} />);
    // The sentence only — the row also carries a timestamp beside it.
    expect(container.querySelector(".activity-sentence")?.textContent).toBe("Dad added Grandma to the family tree");
  });

  it("ends the sentence on the title where that is what reads", () => {
    const { container } = render(<ActivityList items={[activity()]} />);
    expect(container.querySelector(".activity-sentence")?.textContent).toBe("Anna left a note on Dune");
  });

  it("carries a note's own words, since a title alone says nothing happened", () => {
    render(<ActivityList items={[activity({ body: "the middle drags" })]} />);
    expect(screen.getByText(/the middle drags/)).toBeInTheDocument();
  });

  it("links each line to the thing it is about", () => {
    render(<ActivityList items={[activity()]} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/ebooks/books/b1");
  });
});
