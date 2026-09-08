# For you — plan

Status: **Phases 1 and 2 built in-code (2026-09-08)** — `GET /api/for-you`,
the bell counting deliveries (`inbox_delivery_seen`), `/for-you` replacing
Shared with me, delivery rows with the drop link's label, Home showing the
first three rows. Phase 3 remains a proposal. Written 2026-09-08 after the photo review work
([photo-review-plan.md](photo-review-plan.md)) added a third kind of card that
wants something from a person. Companion to
[family-sharing-proposal.md](family-sharing-proposal.md), whose "content is
the conversation" rule this keeps, and to [photo-inbox-proposal.md](photo-inbox-proposal.md).
Like the other plans, decisions are recorded so they need not be re-argued;
open questions so they are not silently answered by whoever writes the code.

Mock (private link, kept for reference while building): the For you page and
the Home page's first-three strip —
https://claude.ai/code/artifact/a2c5b24a-cb43-49d9-9890-6d7ace622a73

## Goal

One place where a person sees **everything that is waiting on them**, each
thing with the one action it wants, and nothing that is not waiting on them.
Today that list is spread over four surfaces that overlap:

| Surface | What it shows | What it misses |
| --- | --- | --- |
| Home, pinned cards | Undecided Send to cards, incl. "Ask what they remember" | Inbox deliveries; and it is also the news feed |
| Home, Photo Inbox card | An Inbox with photos waiting | Which delivery is new |
| Shared with me | The same Send to cards again, then standing access | Anything that is not a Send to |
| The Profile dot | Unseen Send to cards | An Inbox delivery, a review request that arrived as a share |

The idea in one line: **a to-do list that empties, not a timeline that grows.**

## The mental model

| Question | Answer |
| --- | --- |
| What is on the page? | Things addressed to me that I have not dealt with: something sent to me, a question about photos, a delivery into an Inbox I look after. |
| What is not? | News. Someone making an album or leaving a note on a book stays in the Home feed where it fades. |
| What does a row have? | Who, what, and one button that does the thing: Like / Not now, Add what you know, Review. |
| When does a row leave? | When its action is taken, or Not now. Nothing is deleted; the record survives on the thing itself. |
| What lights the bell? | Any row I have not yet **seen** on this page. A dot, never a number. Opening the page clears it. |
| Where did Shared with me go? | It is the lower half of this page: standing access, unchanged. The old addresses keep working. |

## Non-goals

| Not building | Why |
| --- | --- |
| A notification centre of every event | The sharing guide promises "no unread count, and nothing nags". A stream of every album and note would be the internet's inbox, and it is what makes an app tiring for the people this one is for. |
| Badge counts | A dot says "look when you like". A number says "you are behind". |
| Per-row read state on news | News fades on its own in the Home feed; marking it read is bookkeeping nobody asked for. |
| A messenger, replies, threads | Ruled out in the family-sharing proposal and still ruled out. A note lives under its subject. |
| A fan-out table | Five users; a union query over what exists is cheaper and never stale. |

## What already exists

| Piece | Status |
| --- | --- |
| Send to cards, hydrated and access-filtered | **Built** — `loadInboxCards()` in `modules/social/routes.ts`, used by `GET /api/social/inbox` and the Home feed's pinned cards. |
| Review requests | **Built** — a Send to card with `askNotes`; `InboxRow` already renders "Add what you know". |
| The Inbox with photos waiting | **Built** — `photoInboxCards()` in `modules/home/feed.ts`, per Inbox this user may write on, with `reviewed`/`count`. |
| Deliveries | **Built** — `PhotoInboxDelivery` (folder, count, reviewed, newestAt, viaLink) on `GET /api/library/gallery/inbox`. Not surfaced anywhere but the Inbox page. |
| The unseen dot | **Built** — `GET /api/social/inbox/summary` counts recommendations with `seen_at IS NULL`; `POST /api/social/inbox/seen` clears; `useInboxSummary()` draws `.nav-dot` on Profile (desktop and mobile). |
| Shared with me | **Built** — `features/library/SharedWithMePage.tsx` at `/shared` (aliases `/inbox`, `/audiobooks/shared`), in the Profile menu. |
| Row rendering | **Built** — `features/social/InboxRow.tsx` with the three action shapes. |

## Decisions taken

1. **Name: For you.** Not "Inbox" (the Photo Inbox owns that word), not
   "Messages" (there are none), not "Notifications" (see non-goals). "For you"
   says whose list it is.
2. **Address `/for-you`.** `/shared`, `/inbox` and `/audiobooks/shared` keep
   resolving to it, like every reorganisation before.
3. **Three kinds of row, one shape.** `sent` (a Send to card, with or without a
   question), `inbox` (an Inbox this person may write on, with photos waiting),
   `delivery` (one batch that arrived in such an Inbox). All carry `who`,
   `title`, `subtitle`, `coverUrl`, `href`, `action`, `seen`.
4. **A delivery is a row, an Inbox is a row, but not both at once.** An Inbox
   with one delivery shows the delivery; with several, one row per delivery and
   no summary row. The row's action is Review for someone who may Keep, Add
   what you know for someone who may only write — the same split the Home card
   already makes.
5. **Home shows the first three.** The pinned Send to cards and the Photo Inbox
   strip card on Home become the first three rows of this list plus "See all N
   waiting". The photo strip on the Inbox card is the one thing lost; the row
   keeps one cover. Decided because the Home page is not to be a second inbox.
6. **Seen is per person, per row, cheap.** Recommendations already have
   `seen_at`. Deliveries get one: a small table `inbox_delivery_seen (user_id,
   library_id, folder, seen_at)`, stamped when the page is opened, exactly as
   recommendations are today. No column on the delivery itself, since a
   delivery is a folder, not a row.
7. **The bell is the dot.** No new icon on desktop; the Profile button's dot
   now means "something on For you you have not seen", and the menu item
   carries it too. On the phone the Profile tab keeps its dot.
8. **Acting on a row is what already exists.** Like and Not now post to the
   recommendation; Add what you know and Review are links. The page has no new
   writes of its own but "seen".

## Phase 1 — the page

Server: `GET /api/for-you` returns

```ts
{
  waiting: ForYouRow[];   // seen or not, undecided, newest first
  access: SharedAccess;   // what Shared with me lists today, unchanged
}
```

built from `loadInboxCards(user, { onlyNew: true })` mapped to `sent` rows, and
`listPhotoInboxes(user)` filtered to `canEdit` and expanded per decision 4.
`GET /api/social/inbox/summary` counts unseen rows of all three kinds;
`POST /api/social/inbox/seen` stamps all three. Both keep their addresses so
the dot's hook does not change.

Web: `features/social/ForYouPage.tsx` replaces `SharedWithMePage.tsx` — the
same file renamed, with the waiting list generalised over the three row
kinds. `InboxRow` gains the `inbox` and `delivery` shapes (a cover, a line,
one action). Router: `forYou` route, aliases, `forYouHref()`. Profile menu:
"For you". Home: `sentCards` and the Inbox card replaced by the first three
rows and a "See all" link.

Docs: the "When somebody sends you something" and "Shared with me" sections of
[users/family-sharing.md](users/family-sharing.md) become one section; the
Photo Inbox guide's "Fill it" says a delivery shows up on For you.

## Phase 2 — deliveries that say who

A drop-link delivery knows its link's label ("Cousin Anna"). The row says so:
"Cousin Anna sent 12 photos through your link". An upload by a member says who
uploaded, from the activity log. A scan says "Scanner". This is the row's
`who`, and it is the reason a delivery is worth a row at all.

## Phase 3 — later, if wanted

- A note left on something you made (your story, your album) as a row, since
  it is addressed to you in all but name. Waits until someone misses it.
- Security alerts for admins as rows, instead of email only. Probably not:
  they are a different register and the email exists.

## Open questions

1. **Does Not now exist for a delivery?** Answered the day it shipped: yes.
   Four deliveries sat on the owner's Home page with no way to wave them off,
   and "wait until the Inbox is empty" was weeks away. Not now hides the row
   until more photos arrive in that delivery (`inbox_delivery_seen.dismissed_at`,
   migration 73); the Inbox page is untouched.
2. **Should the Home page show three rows or one?** Three, so a household's
   normal day fits without the link. Try it.
3. **Mobile: its own tab, or under Profile?** Under Profile for now; the
   4-tab bar was fought for and a fifth tab needs a stronger case.

## How it ends

A card lands, the dot appears, she opens For you, sees three things that want
her and does them one at a time, and the list is empty. The Home page is the
Home page again.
