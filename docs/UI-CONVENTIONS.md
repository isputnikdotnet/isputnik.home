# UI Conventions

This document defines how user-facing messages, buttons, modals, and confirmations
are built in the web app. The goal: every dialog, button, and error in the app looks
and behaves the same, and new code (human- or AI-written) has exactly one obvious way
to build each of them.

The standard rests on three layers:

1. **Shared primitives** in `apps/web/src/shared/` — the only way to render these elements.
2. **Written rules** (this file, summarized in `CLAUDE.md`) — so AI assistants follow them automatically.
3. **Mechanical enforcement** — `npm run check:ui` fails the build when code bypasses the primitives.

---

## Components

### Button — `shared/Button.tsx`

All buttons render through `<Button>`. Variants map to the classes in
`styles/components.css`; change visuals there, not in components.

| Variant | Class | Use for |
|---|---|---|
| `primary` | `primary-button` | The one affirmative action: Add, Save, Create, Done |
| `secondary` | `secondary-button` | Cancel, Close, Back, neutral actions |
| `danger` | `danger-button` | Filled destructive confirm (Delete) — mostly via ConfirmDialog |
| `text` | `text-button` | Low-emphasis inline action |
| `icon` | `icon-button` | Square icon-only button — must have `aria-label` or `title` |

Modifiers: `danger` (rose tint for destructive icon/text/secondary buttons),
`compact` (42px height for toolbars/rows).

```tsx
<Button variant="primary" type="submit" disabled={saving}>
  {saving ? "Saving…" : "Save changes"}
</Button>
<Button variant="icon" danger title="Delete backup" onClick={...}><Trash2 size={15} /></Button>
```

**Verb vocabulary** (keep it consistent):

- **Add** — put an existing thing somewhere (add to collection, add member).
- **Create** — make a new thing (create tag, create invite link).
- **Remove** — detach without destroying data (remove from group, remove download).
- **Delete** — destroy data; always `danger` + confirmed via ConfirmDialog.
- Never "OK" / "Yes" alone as a confirm label — repeat the verb ("Delete library").

### Modal — `shared/Modal.tsx`

The only way to render a modal. It owns the backdrop, dismissal (backdrop click +
Escape, both blocked while `busy`), and ARIA wiring. Never hand-roll a
`modal-backdrop` div or call `window.confirm` / `alert`.

Two variants:

- **`card`** (default) — compact centered card (`confirm-modal`): title, body,
  `modal-actions` row. Use for confirmations and small one-shot forms.
- **`panel`** — large surface (`metadata-modal`): standard header (optional icon,
  title, close button); children render below (tabs, scrollable content).

Key props: `title` (required — renders as the heading and labels the dialog),
`busy` (blocks all dismissal while an async action runs), `onSubmit` (renders the
dialog as a `<form>`), `icon`, `className` (appended), `surfaceClassName`
(replaces the surface class for bespoke layout CSS — rare; see `BookFilter`),
`headerClassName`, `alert` (alertdialog role — set automatically by ConfirmDialog).

```tsx
<Modal title="New tag" busy={creating} onClose={close} onSubmit={submit}>
  …fields…
  <div className="modal-actions">
    <Button variant="secondary" onClick={close} disabled={creating}>Cancel</Button>
    <Button variant="primary" type="submit" disabled={creating}>Create tag</Button>
  </div>
</Modal>
```

### ConfirmDialog — `shared/ConfirmDialog.tsx`

The only way to ask "are you sure?". Built on Modal.

- `title` is a question naming the object: `Delete "${name}"?`
- Body (children) states the consequence, and what is *not* affected
  ("Files on disk are never touched.").
- `confirmLabel` is a verb phrase; `busyLabel` the in-flight text ("Deleting…").
- `danger` for destructive actions → filled danger button + `alertdialog` role.
- `rich` when the body has its own `<p>` markup; `error` to surface a failed attempt;
  `confirmIcon` for an icon in the confirm button.

```tsx
{pendingDelete && (
  <ConfirmDialog
    title={`Delete "${pendingDelete.name}"?`}
    confirmLabel="Delete tag"
    busyLabel="Deleting…"
    danger
    busy={deleting}
    onConfirm={deleteTag}
    onCancel={() => setPendingDelete(null)}
  >
    This removes the tag from {n} books. Books and files are not affected.
  </ConfirmDialog>
)}
```

### MessageBox — `shared/MessageBox.tsx`

The only way to show an inline message. Tones: `info`, `warning`, `error`,
`success`. Errors get `role="alert"` automatically.

```tsx
{error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
```

Error message copy: say what failed and keep the server message when it's useful —
`"Unable to create collection"`, not `"Something went wrong"`.

---

## Microcopy rules

- Sentence case everywhere ("Create invite link", not "Create Invite Link").
- Confirmation titles are questions naming the object: `Delete "Fantasy"?`
- Destructive bodies say what is destroyed **and** what survives.
- Busy states repeat the verb with an ellipsis: "Saving…", "Deleting…".
- Cancel is always `secondary` and sits left of the confirm button in `modal-actions`.

---

## Enforcement

`npm run check:ui` (also part of `npm run typecheck`-level CI hygiene) scans
`apps/web/src` and fails when:

- `window.confirm` / `window.alert` / bare `confirm(` / `alert(` appear;
- `modal-backdrop` is used outside `shared/Modal.tsx`;
- `confirm-modal` / `metadata-modal` surface classes are instantiated outside `shared/`.

If the checker blocks something legitimately new, extend the shared component
(new prop or variant) rather than bypassing it — that is the entire point.

## Why this matters for AI-generated code

AI assistants imitate the surrounding code. Because every modal, button, and message
in the codebase goes through these primitives, generated code will follow the same
path; `CLAUDE.md` states the rules up front, and `check:ui` catches anything that
slips through. When adding a new UI pattern, add it to `shared/` first, then use it —
never inline a one-off.
