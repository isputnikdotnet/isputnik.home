# isputnik.home

Private self-hosted family media library. npm workspaces: `apps/server` (Fastify + SQLite)
and `apps/web` (React + Vite PWA).

- `npm run dev` — server on :4000 + Vite dev server
- `npm run typecheck` — both workspaces
- `npm run check:ui` — UI-convention checker (see below)

## Server architecture (core vs modules)

Background: `docs/architecture-restructure-proposal.md`. The rule:

- **`apps/server/src/core/` is platform infrastructure ONLY** — things every
  feature depends on with no product knowledge: auth/sessions, permissions,
  config, logging/status, db access, setup, shared request helpers. Never put
  audiobook-, ebook-, user-, or other feature-specific logic here.
- **`apps/server/src/modules/` holds product features** — `users`, `uploads`,
  `backups`, `collections`, and `library` (with media types nested under
  `library/audiobook`, `library/ebook`, … over a shared `library/shared` layer).
- **Media types nest under `library/`**, they are not top-level peers of it.
  A new media type goes in `modules/library/<type>/` and must join the
  cross-type systems (categories, tags, collections, bookmarks) by filtering on
  `libraries.type` and passing the correct `entityType`.
- Each module exposes a Fastify plugin from its `index.ts`; register it in
  `apps/server/src/index.ts` as a sibling of `corePlugin`. Auth decorators
  (`authenticate`/`requireAdmin`) are added on the root app, so they propagate
  to every plugin regardless of registration nesting.

## UI conventions (web app)

Full reference: `docs/UI-CONVENTIONS.md`. The short version:

- **Never hand-roll a modal.** Use `shared/Modal` (`card` for small dialogs/forms,
  `panel` for large surfaces with a header). Never write a `modal-backdrop` div,
  and never use `window.confirm` / `alert` — `npm run check:ui` fails on these.
- **Confirmations** go through `shared/ConfirmDialog`. Title is a question naming
  the object (`Delete "X"?`); body states the consequence and what is not affected;
  `danger` for destructive actions; confirm label is a verb ("Delete library"),
  never "OK"/"Yes" alone.
- **Buttons** render through `shared/Button` with an explicit variant:
  `primary` (Add/Save/Create), `secondary` (Cancel/Close), `danger` (Delete),
  `text`, `icon` (needs `aria-label`/`title`). Verbs: **Add** = attach existing,
  **Create** = make new, **Remove** = detach (no data loss), **Delete** = destroy
  (always confirmed).
- **Messages**: inline errors/notices use `shared/MessageBox` with a tone
  (`info|warning|error|success`); no custom error divs. Error titles say what
  failed ("Unable to save").
- Busy states repeat the verb with an ellipsis ("Saving…"); pass `busy` to
  Modal/ConfirmDialog so dismissal is blocked while an action runs.
- New UI pattern needed? Extend the shared component (prop/variant) in
  `apps/web/src/shared/` first — never inline a one-off.

After UI changes run `npm run typecheck` and `npm run check:ui`.
