# Family tree

The family tree records the people in your family, how they're related, what
happened in their lives, and the photos that go with it. It sits beside your
libraries in the main menu.

Unlike a library, it isn't pointed at a folder — there's nothing to scan. You
either type people in, or import a GEDCOM file from another genealogy service.

> **Worth knowing up front:** a library can always be rebuilt by re-scanning its
> folder, but **the family tree exists only in the app's database**. Include the
> database in your backups, or export a GEDCOM file now and then.

## Adding people

**Add person** creates a family member. Only a name is required; everything else
— dates, places, a photo, a life story — can come later.

Dates are deliberately forgiving. `1943`, `1943-05` and `1943-05-09` are all
valid, because genealogy is full of records where only the year is known. A
year-only date stays a year-only date; nothing silently invents a day for it.

Once someone exists, open their profile and use **Add relative** to attach a
**parent**, **partner**, **child** or **sibling**. Relationships hang off
couples, which is what lets the app handle remarriages, single parents, and
step- or adopted children without special cases.

You can also build the tree without leaving the chart: each card you're allowed
to edit carries a **+** button that adds a **parent** or a **child** to that
person directly. Partners and siblings stay on the profile, where the rest of
their family is in view.

## The chart

![The family tree chart, four generations with the relationship legend](images/40-family-tree.png)

The tree view centres on one person: parents and grandparents above,
children below, partners alongside, and siblings and cousins on their own
generation's row. Click any card to re-centre on that person — the browser's
Back button retraces your steps. Drag to pan, scroll or pinch to zoom.

Down the right edge of each card are small round buttons: **open their profile**,
and — if you're allowed to edit that person — **edit** them and **+** to add a
parent or child.

**Where it starts.** Opening the family tree centres on the **starting person**,
which an admin chooses once in Settings → Starting person. It's the same for
everyone. Until one is chosen the tree opens on whoever happens to come first,
which is rarely the person you'd pick. Following a link to a particular
person — from search, All people, or a bookmark — still opens on them.

## A person's profile

![A person's profile on its Relationships tab: parents, partner and children](images/41-family-person.png)

Six tabs:

- **Relationships** — parents, siblings, grandparents, partners and children as
  cards you can jump to.
- **Timeline** — their life in order: birth, marriages, the births of children,
  death, plus any events you add (education, work, homes, military service,
  travel, awards, graduations, retirements, baptisms, naturalisations…). Each
  event can carry its own photos and notes.
- **Photos** — see below.
- **Sources** — where a fact came from: a parish register, a certificate, a web
  page. Sources are shared, so one record can back many facts.
- **Biography** — their life story in your own words.
- **Quotes** — the things they said, whenever anyone recorded one against their
  name. See [Quotes](quotes.md).

## Photos

Two ways a photo reaches a profile:

1. **You attach it.** *Add photos* opens a browser over your gallery libraries;
   pick any photos and they're attached. Nothing is copied — the tree points at
   the photo where it already lives.
2. **Face recognition finds it.** Link a person to a face group (Photos tab →
   *Link gallery person*) and every photo of that face appears automatically.
   See [Gallery](library-gallery.md#face-recognition).

The tab shows a preview with **View all photos** for the rest. Photos open in a
viewer over the family page, so closing one brings you back to the tree rather
than dropping you in the gallery.

**Uploading new photos** works from the same picker's *Upload* tab, once an
admin has chosen which gallery library family-tree uploads go into (Settings →
Photo library). Files are added to that library and attached in one step.

## Settings

The gear on the tree page — admins only — holds four things:

| Tab | What it's for |
|---|---|
| **Photo library** | Which gallery library uploaded family photos are added to |
| **Starting person** | Who the chart opens on, for everyone |
| **Import / export** | GEDCOM in and out |
| **Security** | Who may edit which branch — see below |

**Starting person** — select **Choose a person**, search for them, and that's it;
the change applies immediately for everyone. **Change** picks someone else and the
**✕** clears the setting, putting the tree back to its own guess. If the person
you chose is later deleted from the tree, the setting quietly stops applying
rather than breaking the chart.

## Letting a relative maintain their own branch

By default everyone can *see* the tree but only administrators can change it.
That's often too strict for a family where a cousin knows their own side best.

**Branch access** solves it with tags:

1. **Tag the people in a branch.** The quickest way is the tag button (🏷) on a
   family's card on the **Families** page — it opens with that family's members
   already gathered. **Add relatives** then pulls in everyone connected to them
   through the tree, which is what you usually want: surnames change with
   marriage, so a married-in spouse belongs to the branch without sharing its
   name. Drop anyone who doesn't belong with the **✕** on their chip, type a tag
   name, **Create** it, and **Apply tags**.

   You can start from **People** instead when the branch isn't one family:
   **Select**, tick the people (or **All** to take everyone the current search
   and tag filter leave on screen), then **Tags**. Tagging one person on their
   own still works from Edit person → *Tags*.

   Tags add up rather than replace: someone who sits in two branches can carry
   both tags, and a bulk add never disturbs the tags a person already has. Click
   a tag once to give it to everyone in the selection, again to take it from
   everyone, and a third time to leave each person as they are.
2. **Grant editing on that tag.** Settings → Security → pick the tag, choose a
   person or group, and add them as **Editor**.

That person can now edit everyone carrying the tag and add relatives to them —
and anyone they add joins the branch automatically. They cannot delete people,
unpick relationships, import GEDCOM files, or change tags; those stay with
administrators.

Assigning tags is deliberately admin-only. If editors could tag, they could pull
any person into their own branch and give themselves rights over them.

## GEDCOM — bringing a tree in, or taking it out

GEDCOM is the standard genealogy file, understood by Ancestry, MyHeritage,
Gramps and others.

- **Import** (Settings → Import / export) reads people, families, events and
  sources. It offers **add** — merge into what's here — or **replace**, which
  clears the existing tree first. Anything it can't interpret becomes a warning
  rather than a failed import.
- **Export** writes the whole tree to one file. Available to everyone, not just
  admins, and the simplest backup of your genealogy work there is.

Photos are *not* part of a GEDCOM file, since they live in your gallery. After
an import you'd re-attach them.
