# Permissions & Access — Proposal (Draft)

> **Status:** Draft for discussion. Not implemented yet. The goal is to agree on the
> model before touching code. The database can be reset, so no migration is needed.

## Why change anything

Right now "who can do what to a library" is answered in **too many places**: owner
columns on the library, a `library_members` grants table, a `visibility` flag, a
`public_role` flag, plus group roles — and there is a separate, mostly-unused
permission system for shares. Same question, five answers.

This proposal replaces all of that with **one simple idea used everywhere**:

> An **assignment** says *"this subject has this role on this object."*
> One table, one check function, the same rules for every kind of object.

---

## The four pieces

1. **Users** — the accounts. No global role column: whether someone is a server admin
   is decided by membership in the built-in **System Admins** group (see below).
2. **Groups** — named sets of users (e.g. *Family*, *Kids*). Plus two **built-in,
   undeletable system groups**: **Everyone** (public access) and **System Admins**
   (server administrators).
3. **Assignments** — the heart of it. Each row = *subject → role → object*.
   The subject is a user **or** a group. The object is a library today, and can be a
   collection or anything else later.
4. **Shares** — one merged table for item-level sharing (a user share **or** a guest
   link). Always means the same thing: "view + download this one item."

**Roles are just labels** (`viewer`, `member`, `contributor`, `manager`) stored in the
assignment. What each label is allowed to do lives in **code**, not in a table — see
[Roles](#roles). (Decided: we are **not** building a configurable roles table.)

---

## Roles

Four roles, each includes everything below it:

| Action | Viewer | Member | Contributor | Manager |
|---|:--:|:--:|:--:|:--:|
| View / play / read in-app | ✓ | ✓ | ✓ | ✓ |
| Download (export the file) | | ✓ | ✓ | ✓ |
| Add / edit content | | | ✓ | ✓ |
| Administer (members, settings, delete) | | | | ✓ |

Plus one **special, non-tier** value:

- **Deny** — an explicit **block**, not a level. A `deny` assignment for a user (or any
  group they're in) removes access entirely and **overrides every grant, including
  Everyone**. Use it for *"public to everyone **except** this group"* (e.g. an adult
  library that is `Everyone = member` but `Kids = deny`). It does **not** apply to server
  admins — to hide something from admins too, make the library private (no Everyone grant),
  don't use deny.

Notes:
- **Member** = view + download (library "borrowing" rights). *Renamed from Subscriber.*
- **Contributor** = can also add/edit content — the safe "everyone can contribute"
  level for a shared library, without handing out administration.
- **Manager** = full control of *one* object (the old "owner" / "Library Admin").
- **Server admins** (members of System Admins) act as **manager** on every object —
  *except* a private library they haven't been granted. See [Admins & built-in groups](#admins--built-in-groups).
- **Download / contribute are the role, not separate switches.** "Public, view-only" vs
  "view + download" vs "everyone can contribute" is simply which role **Everyone** holds.
- **Everyone may be `viewer`, `member`, or `contributor` — never `manager`.** Making every
  signed-in user an administrator of a library (delete it, remove others) is blocked.

---

## How the common cases map

| Situation | Assignment(s) |
|---|---|
| **Public library, downloads on** | `Everyone → member → library#5` |
| **Public library, view only** | `Everyone → viewer → library#5` |
| **Public library everyone can add to** | `Everyone → contributor → library#5` |
| **Private library owned by Bob** | `Bob → manager → library#5` (no Everyone row) |
| **Give the Family group access** | `Family(group) → member → library#5` |
| **Cap one group to view-only** | `Kids(group) → viewer → library#5` (overrides Everyone) |
| **Public, but block one group** | `Everyone → member` **and** `Kids(group) → deny → library#5` |
| **Share a book with Alice** | `shares(book#9, user = Alice)` |
| **Guest link to a book** | `shares(book#9, token = …)` |

**Owner** is no longer a special thing — it is simply the `manager` assignment, added
automatically to whoever you pick when creating the library.

### Creating a library
- **Public** → the **Everyone** group is assigned a role (View only / View + download).
  Picking a specific owner is optional; if you do, they also get `manager`.
- **Private** → you **must** pick an owner; that user is assigned `manager`. No Everyone
  row, so only the owner (and anyone else granted) can reach it — **not even admins**,
  until an admin explicitly *takes ownership* (see [Admins & built-in groups](#admins--built-in-groups)).

Independently of public/private, you also pick the library's **mode** — *Managed* or
*External (read-only)* — and its write policies. See
[Library mode & policies](#library-mode--policies-a-separate-axis).

---

## Admins & built-in groups

The app creates two system groups that can't be deleted or renamed:

- **Everyone** — a *virtual* group: it has no member rows; the check treats an
  assignment to Everyone as matching any signed-in user. Used for public access.
  It is **fully locked** — you can't rename it, delete it, or edit its membership (its
  membership is implicitly "all signed-in users"). You can only *assign it a role on an
  object* (that's what makes the object public — using the group, not editing it).
- **System Admins** — real membership. The original account is a **permanent** member;
  it reuses the existing `protected_from_delete` flag, which now also means
  *"can't be removed from System Admins."* Add other users here to make them admins.

**There is no `users.role` column** — "is this person a server admin?" simply means
"are they in System Admins?".

**What an admin can do:** a System Admin acts as **manager on everything** — app
settings, user/group management, and every public object — **with one exception:**

> A **private library** (one with no Everyone grant) that the admin hasn't been granted
> is **off-limits, even to admins**. This keeps a family member's private library
> private from the server owner.

To get in, an admin uses **Take ownership** — an admin-only action that adds a `manager`
assignment (for the admin, or the System Admins group) on that library. It is **written
to the activity log**, so reaching a private library is always a visible, deliberate
step, never a silent peek.

## How a permission check works

One function, used for every object in the app:

```
can(user, object, action)
```

```mermaid
flowchart TD
    Start["can(user, object, action)?"] --> Admin{"in System Admins?"}
    Admin -- yes --> Priv{"private library,<br/>no grant for this admin?"}
    Priv -- yes --> DenyA["deny — use Take ownership"]
    Priv -- no --> Allow["allow (acts as manager)"]
    Admin -- no --> DenyChk{"a 'deny' for this user<br/>or their groups?"}
    DenyChk -- yes --> Deny["deny"]
    DenyChk -- no --> Gather["collect assignments on the object:<br/>own + groups + Everyone"]
    Gather --> Has{"any assignment?"}
    Has -- no --> Deny
    Has -- yes --> Strong["take the strongest role"]
    Strong --> Map{"does that role allow the action?"}
    Map -- yes --> Allow
    Map -- no --> Deny
```

**Order that matters:** `deny` first (it beats everything), then **strongest role wins**,
and an explicit user/group grant **overrides Everyone** — so you can grant `Kids → viewer`
to cap them to view-only, or `Kids → deny` to block them outright, on an otherwise-public
library.

---

## How the pieces relate

```mermaid
flowchart TD
    U["users<br/>(no role column)"]
    G["groups<br/>built-in: Everyone, System Admins"]
    GM["group_members<br/>group_id, user_id"]
    A["assignments<br/>subject → role → object"]
    O["objects<br/>library (collection, … later)"]
    S["shares<br/>item + user OR token"]

    U --> GM
    G --> GM
    U -- "subject" --> A
    G -- "subject" --> A
    O -- "object" --> A
    U -- "recipient" --> S
    O -- "shared item" --> S
```

`Everyone` is a **virtual** group: it has *no* member rows. The check simply treats an
assignment to Everyone as matching any signed-in user. System groups can't be renamed
or deleted.

---

## Schema sketch

```sql
-- Accounts: no role column. Admin = membership in the System Admins group.
-- protected_from_delete marks the seed admin (undeletable, can't leave System Admins).
users(id, …, protected_from_delete);

-- Groups, including the built-in system groups: Everyone + System Admins.
groups(id, name, kind CHECK (kind IN ('normal', 'system')));
group_members(group_id, user_id, PRIMARY KEY (group_id, user_id));

-- One row = "this subject has this role on this object".
assignments(
  subject_type CHECK (subject_type IN ('user', 'group')),
  subject_id,                              -- polymorphic, no FK
  object_type,                             -- 'library' now; 'collection', … later
  object_id,                               -- polymorphic, no FK
  role         CHECK (role IN ('viewer', 'member', 'contributor', 'manager', 'deny')),
  PRIMARY KEY (subject_type, subject_id, object_type, object_id)
);

-- Item shares — user share OR guest link, in one table.
shares(
  id, object_type, object_id,
  user_id,        -- set for a user-to-user share
  token_hash,     -- set for a guest link
  expires_at, revoked_at, created_by, created_at
);
```

---

## Library mode & policies (a separate axis)

Roles answer *"what may **this user** do?"*. **Policies** answer *"what is allowed on
**this library at all**, no matter who you are?"*. They are a different axis, and an
action is allowed only when **both** pass:

```
allowed(action) = role_allows(user, action)   AND   policy_allows(library, action)
```

So a policy caps **everyone** — Contributor, Manager, *and* server admin alike. Policies
only gate **write** actions (upload, edit-on-disk, delete); **reads are never blocked by
policy** — an external library is fully viewable and streamable, just not writable.

### Library mode

Chosen when the library is created:

- **Managed** — this app owns the content; uploads / edits / deletes are possible
  (still subject to the user's role).
- **External (read-only)** — points at a folder another tool manages (e.g. **Plex** or
  **Audiobookshelf**). **View & stream only — never written to**, by anyone. This lets
  people use the app purely as a viewer/streamer over libraries they manage elsewhere,
  with no risk of overwriting them.

### Policy object (dynamic, no migrations)

The finer rules — which only matter where writes happen — live in a JSON object on the
library row, alongside the existing `settings_json`:

```jsonc
// libraries.policy_json
{
  "mode": "external",            // or "managed"
  "allowUpload": false,          // forced false when mode = external
  "allowDelete": false,          // subsumes the old "disable file deletion" idea
  "allowedExtensions": ["mp3", "m4b", "epub", "pdf"],
  "maxUploadMB": 1024
}
```

Same philosophy as roles — **values in data, meaning in code**: adding a new policy (say
"max total library size") is just a new key, **no column and no migration**. The app
reads the blob and enforces the keys it knows (`policyAllows(library, action, file)`);
unknown keys are ignored. Keep the *enforcement* in code — the JSON only holds settings,
it is not a rules engine.

### Notes
- **Downloads stay a role, not a policy** — some users can download and some can't, so
  it belongs to the role (Member+), not a library-wide switch.
- **Upload / delete are reserved** — no such feature exists yet (the app currently never
  writes to source files, a core safety rule), but the **gate is defined now** so the
  features can't ship without honouring mode & policy.
- **One entry point** — the single `can(user, object, action)` folds this in internally
  (`role_allows && policy_allows`), so callers still make one check.

---

## What we clean up (short summary)

Replacing today's model with this proposal removes the overlap:

| Today | Becomes |
|---|---|
| `libraries.owner_id` / `owner_type` columns | a `manager` **assignment** |
| `libraries.visibility` + `libraries.public_role` | presence/role of the **Everyone** assignment |
| `library_members` table | the generic **`assignments`** table (`object_type = 'library'`) |
| `group_members.role` (member / manager) | plain membership (role not needed for libraries) |
| `shares` + `share_links` (two tables) | one merged **`shares`** table |
| `shares.permission` / `share_links.permission` (read/edit/manage — only `read` used) | removed |
| 5 library roles + 7 capabilities (`viewer…admin`, incl. unused `upload`/`curator`) | **4 roles** (`viewer`/`member`/`contributor`/`manager`) + a `deny` block |
| `users.role` (`admin`/`member`) | membership in the **System Admins** group |
| `resolveLibraryRole(...)` (library-only) | generic **`can(user, object, action)`** |

Net: the access data goes from **4 join tables + several overlapping columns** to
**`assignments` + `group_members` + one merged `shares`**, with no standalone role
column — admin status comes from the System Admins group. Code-side, one `can()`
replaces the library-specific resolver and the per-endpoint capability helpers.

---

## Open questions (to think about)

1. **`group_members.role`** — drop it entirely, or keep a `manager` flag for *managing
   the group itself* (who can add/remove members)?
2. **Policy switches** — which, if any, do we actually need now beyond download-via-role?
3. **Scope of the rollout** — generalize `object_type` immediately (collections, etc.),
   or ship libraries-only with the column ready for later?
4. **Take ownership** — when an admin takes over a private library, does the original
   owner's `manager` grant stay, or get replaced?

*Decided so far:* roles `viewer` / `member` / `contributor` / `manager` (+ `deny`);
Everyone may be viewer/member/contributor but never manager; two built-in locked groups
(Everyone + System Admins); admin = System Admins membership (no `users.role`); private
libraries stay hidden from admins until they take ownership, which is logged.

---

## Related documents
- [`library-sharing.md`](library-sharing.md) — the current (to-be-replaced) library access model.
- [`sharing.md`](sharing.md) — the current item-level share model.
