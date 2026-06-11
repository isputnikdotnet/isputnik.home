# AGENTS.md

## UI conventions (web app)

Full reference: `docs/UI-CONVENTIONS.md`. The short version:

- **Never hand-roll a modal.** Use `shared/Modal` (`card` for small dialogs/forms,
  `panel` for large surfaces with a header). Never write a `modal-backdrop` div,
  and never use `window.confirm` / `alert` - `npm run check:ui` fails on these.
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
- Busy states repeat the verb with an ellipsis ("Saving..."); pass `busy` to
  Modal/ConfirmDialog so dismissal is blocked while an action runs.
- New UI pattern needed? Extend the shared component (prop/variant) in
  `apps/web/src/shared/` first - never inline a one-off.
