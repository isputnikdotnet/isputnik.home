import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxRow, type InboxCard } from "../src/features/social/InboxRow";
import { DeliveryRow, type DeliveryCard } from "../src/features/social/DeliveryRow";
import { ActivityFeedCard, type ActivityItem } from "../src/features/social/ActivityCard";

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

  it("turns an album sent with a question into the screen that answers it", () => {
    // "Ask what they remember" (docs/photo-review-plan.md, phase 3): the line is
    // the question, the primary action opens Review mode over the album with
    // the card's id so finishing can clear it, and Not now stays available.
    render(<InboxRow card={card({ entityType: "gallery_album", entityId: "alb1", savable: false, askNotes: true, href: "/gallery/albums/alb1" })} busy={false} onAct={vi.fn()} />);
    expect(screen.getByText("Dad asks what you remember about these photos")).toBeInTheDocument();
    const open = screen.getByRole("link", { name: /Add what you know/ });
    expect(open).toHaveAttribute("href", "/gallery/review/album/alb1?from=r1");
    expect(screen.getByRole("button", { name: /Not now/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Done/ })).not.toBeInTheDocument();
  });

  it("turns a delivery into a row that names who sent it and offers the right way in", () => {
    // For you (docs/for-you-plan.md): a batch that arrived through a drop link.
    const delivery: DeliveryCard = {
      kind: "delivery", id: "delivery:inbox:Cousin Anna", libraryId: "inbox", libraryName: "Photo Inbox",
      folder: "Cousin Anna", count: 12, reviewed: 0, viaLink: true, who: "Cousin Anna",
      newestAt: "2026-09-08T10:00:00Z", seen: false, coverUrl: null, canReview: true
    };
    const { rerender } = render(<ul><DeliveryRow card={delivery} /></ul>);
    expect(screen.getByText("Cousin Anna sent 12 photos through your link")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review/ })).toHaveAttribute("href", "/gallery/inbox/inbox");
    expect(screen.getByRole("link", { name: /One at a time/ })).toHaveAttribute("href", "/gallery/inbox/inbox".replace("/inbox/inbox", "/review/inbox?folder=Cousin%20Anna"));

    // Someone who may only write on the photos gets Review mode, not the Inbox page.
    rerender(<ul><DeliveryRow card={{ ...delivery, canReview: false, viaLink: false, who: null }} /></ul>);
    expect(screen.getByText("12 photos arrived in Photo Inbox")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add what you know/ })).toHaveAttribute("href", "/gallery/review/inbox?folder=Cousin%20Anna");
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
  chapter: null,
  ...over
});

describe("activity cards", () => {
  // The card splits the sentence into a lead line and a title, so the whole
  // sentence — in the order that reads — is pinned on the link's accessible name.
  const sentence = (item: ActivityItem) => {
    render(<ActivityFeedCard item={item} />);
    return screen.getByRole("link").getAttribute("aria-label")?.split(", ")[0];
  };

  it("reads as a sentence, with the title in the middle where it belongs", () => {
    // The first version put the title last in every line, which produced
    // "Dad added to the family tree Grandma".
    expect(sentence(activity({ kind: "person", actorName: "Dad", title: "Grandma" }))).toBe("Dad added Grandma to the family tree");
  });

  it("ends the sentence on the title where that is what reads", () => {
    expect(sentence(activity())).toBe("Anna left a note on Dune");
  });

  it("shows who did what above the title, and the title on its own", () => {
    const { container } = render(<ActivityFeedCard item={activity({ kind: "person", actorName: "Dad", title: "Grandma" })} />);
    expect(container.querySelector(".activity-lead")?.textContent).toBe("Dad added to the family tree");
    expect(container.querySelector(".activity-title")?.textContent).toBe("Grandma");
  });

  it("carries a note's own words, since a title alone says nothing happened", () => {
    render(<ActivityFeedCard item={activity({ body: "the middle drags" })} />);
    expect(screen.getByText(/the middle drags/)).toBeInTheDocument();
  });

  it("links each card to the thing it is about", () => {
    render(<ActivityFeedCard item={activity()} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/ebooks/books/b1");
  });

  it("names an added chapter in the story's own words, then the story", () => {
    expect(sentence(activity({
      kind: "story_update", actorName: "Dad", title: "Alps in summer",
      chapter: { id: "c4", title: "The last climb", noun: "Day", number: 4 }
    }))).toBe("Dad added Day 4 to Alps in summer");
  });

  it("falls back to the chapter's title, then a plain chapter number", () => {
    const titled = render(<ActivityFeedCard item={activity({
      kind: "story_update", actorName: "Dad", title: "Alps in summer",
      chapter: { id: "c4", title: "The last climb", noun: null, number: 4 }
    })} />);
    expect(titled.getByRole("link").getAttribute("aria-label")?.split(", ")[0]).toBe("Dad added The last climb to Alps in summer");
    titled.unmount();
    expect(sentence(activity({
      kind: "story_update", actorName: "Dad", title: "Alps in summer",
      chapter: { id: "c4", title: null, noun: null, number: 4 }
    }))).toBe("Dad added Chapter 4 to Alps in summer");
  });
});
