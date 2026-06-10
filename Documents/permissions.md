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

1. **Users** — the accounts. Each has one global flag: `admin` or `member`.
   `admin` is a super-user over the whole app. Nothing else changes here.
2. **Groups** — named sets of users (e.g. *Family*, *Kids*). Plus **built-in system
   groups** the app creates and protects — most importantly **Everyone**.
3. **Assignments** — the heart of it. Each row = *subject → role → object*.
   The subject is a user **or** a group. The object is a library today, and can be a
   collection or anything else later.
4. **Shares** — one merged table for item-level sharing (a user share **or** a guest
   link). Always means the same thing: "view + download this one item."

**Roles are just labels** (`viewer`, `subscriber`, `manager`) stored in the
assignment. What each label is allowed to do lives in **code**, not in a table — see
[Roles](#roles). (Decided: we are **not** building a configurable roles table.)

---

## Roles

Three roles, each includes everything below it:

| Action | Viewer | Subscriber | Manager |
|---|:--:|:--:|:--:|
| View / play / read in-app | ✓ | ✓ | ✓ |
| Download (export the file) | | ✓ | ✓ |
| Edit metadata, organize, manage members & settings | | | ✓ |

- **Global `admin`** (on the user) is above all of this — full access everywhere.
- **Manager** = full control of *one* object (the old "owner" / "Library Admin").
- **Download is the role, not a separate switch.** "Public, view-only" vs "Public,
  with downloads" is simply whether **Everyone** is assigned `viewer` or `subscriber`.

---

## How the common cases map

| Situation | Assignment(s) |
|---|---|
| **Public library, downloads on** | `Everyone → subscriber → library#5` |
| **Public library, view only** | `Everyone → viewer → library#5` |
| **Private library owned by Bob** | `Bob → manager → library#5` (no Everyone row) |
| **Give the Family group access** | `Family(group) → subscriber → library#5` |
| **Cap one group to view-only** | `Kids(group) → viewer → library#5` (overrides Everyone) |
| **Share a book with Alice** | `shares(book#9, user = Alice)` |
| **Guest link to a book** | `shares(book#9, token = …)` |

**Owner** is no longer a special thing — it is simply the `manager` assignment, added
automatically to whoever you pick when creating the library.

### Creating a library
- **Public** → the **Everyone** group is assigned a role (View only / View + download).
  Picking a specific owner is optional; if you do, they also get `manager`.
- **Private** → you **must** pick an owner; that user is assigned `manager`. No Everyone
  row, so only the owner (and global admins) can reach it until more assignments are added.

---

## How a permission check works

One function, used for every object in the app:

```
can(user, object, action)
```

```mermaid
flowchart TD
    Start["can(user, object, action)?"] --> Admin{"user is global admin?"}
    Admin -- yes --> Allow["allow"]
    Admin -- no --> Gather["collect this user's assignments on the object:<br/>their own + their groups + Everyone"]
    Gather --> Has{"any assignment?"}
    Has -- no --> Deny["deny"]
    Has -- yes --> Strong["take the strongest role"]
    Strong --> Map{"does that role allow the action?"}
    Map -- yes --> Allow
    Map -- no --> Deny
```

**Strongest role wins**, and an explicit user/group assignment **overrides Everyone** —
so you can grant `Kids → viewer` on an otherwise-downloadable public library to hold
them to view-only.

---

## How the pieces relate

```mermaid
flowchart TD
    U["users<br/>role: admin / member"]
    G["groups<br/>kind: normal / system (Everyone)"]
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
-- Accounts: the only GLOBAL role (super-user flag). Unchanged.
users(id, …, role CHECK (role IN ('admin', 'member')));

-- Groups, including built-in system groups (Everyone).
groups(id, name, kind CHECK (kind IN ('normal', 'system')));
group_members(group_id, user_id, PRIMARY KEY (group_id, user_id));

-- One row = "this subject has this role on this object".
assignments(
  subject_type CHECK (subject_type IN ('user', 'group')),
  subject_id,                              -- polymorphic, no FK
  object_type,                             -- 'library' now; 'collection', … later
  object_id,                               -- polymorphic, no FK
  role         CHECK (role IN ('viewer', 'subscriber', 'manager')),
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

## Per-library policy switches (a separate axis)

A *role* says what a person can do. A *policy* is a library-wide rule that limits
**everyone**, even managers. Keep these few and clearly labelled "library settings":

- **Downloads** — already covered by the Everyone role; **not** a separate switch.
- **File deletion from the website** — note the app currently **never deletes source
  files** (read-only is a core safety rule), so there may be nothing to gate today.
  If destructive features are added later, model them as a policy flag, not a role.

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
| 5 library roles + 7 capabilities (`viewer…admin`, incl. unused `upload`/`contributor`/`curator`) | **3 roles** (`viewer`/`subscriber`/`manager`) |
| `resolveLibraryRole(...)` (library-only) | generic **`can(user, object, action)`** |

Net: the access data goes from **4 join tables + several overlapping columns** to
**`assignments` + `group_members` + one merged `shares`**, with `users.role` as the
only standalone flag. Code-side, one `can()` replaces the library-specific resolver and
the per-endpoint capability helpers.

---

## Open questions (to think about)

1. **Role names** — are `viewer` / `subscriber` / `manager` the right three? (We had
   five before; this drops Contributor and Curator.)
2. **`group_members.role`** — drop it entirely, or keep a `manager` flag for *managing
   the group itself* (who can add/remove members)?
3. **Policy switches** — which, if any, do we actually need now beyond download-via-role?
4. **Scope of the rollout** — generalize `object_type` immediately (collections, etc.),
   or ship libraries-only with the column ready for later?
5. **Built-in groups** — just **Everyone**, or also an **Administrators** group instead
   of the `users.role = 'admin'` flag? (Recommendation: keep the flag, add only Everyone.)

---

## Related documents
- [`library-sharing.md`](library-sharing.md) — the current (to-be-replaced) library access model.
- [`sharing.md`](sharing.md) — the current item-level share model.
