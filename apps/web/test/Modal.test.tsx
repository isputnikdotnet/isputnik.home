import { useState } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/shared/Button";
import { ConfirmDialog } from "../src/shared/ConfirmDialog";
import { Modal } from "../src/shared/Modal";

// Modal is the primitive every dialog in the app stands on, so what it promises
// has to hold everywhere at once: only the TOPMOST open dialog answers Escape and
// its backdrop (a confirm over an editor must not take the editor with it), `busy`
// blocks both, focus goes in on open, stays in on Tab, and comes back on close, and
// the page behind is `inert` for as long as any dialog is up.

let appRoot: HTMLElement;

beforeEach(() => {
  // What index.html gives React. RTL's cleanup unmounts and removes it after each test.
  appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.appendChild(appRoot);
});

const renderApp = (ui: React.ReactElement) => render(ui, { container: appRoot });

/** A panel editor with a Delete that asks first — the shape of PersonProfileModal,
 *  DropLinksModal, StoryCollectionFormModal… */
function Editor({ onClose, confirmBusy = false }: { onClose: () => void; confirmBusy?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Modal variant="panel" title="Edit person" onClose={onClose}>
      <label>
        Name
        <input defaultValue="Anna" />
      </label>
      <Button variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
      {confirming && (
        <ConfirmDialog
          title='Delete "Anna"?'
          confirmLabel="Delete person"
          busy={confirmBusy}
          danger
          onConfirm={() => undefined}
          onCancel={() => setConfirming(false)}
        >
          Her photos stay in the gallery.
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** A page with a trigger, for the focus round trip. */
function Page({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && children(() => setOpen(false))}
    </>
  );
}

const backdropOf = (dialog: HTMLElement) => dialog.closest(".modal-backdrop") as HTMLElement;

describe("Modal", () => {
  it("renders into <body>, outside the app root, and makes the root inert while open", () => {
    const { unmount } = renderApp(<Modal title="New tag" onClose={vi.fn()}><p>Body</p></Modal>);

    const dialog = screen.getByRole("dialog", { name: "New tag" });
    expect(appRoot.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(appRoot).toHaveAttribute("inert");

    unmount();
    expect(appRoot).not.toHaveAttribute("inert");
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("stays inside a layer that already lives outside the app root (the lightbox)", () => {
    renderApp(
      createPortal(
        <div className="gallery-lightbox">
          <Modal title="Add to album" onClose={vi.fn()}><p>Albums</p></Modal>
        </div>,
        document.body
      )
    );
    const dialog = screen.getByRole("dialog", { name: "Add to album" });
    // So `.gallery-lightbox .modal-backdrop` (its dark palette) and the lightbox's
    // stacking still apply, as they did before the portal.
    expect(document.querySelector(".gallery-lightbox")!.contains(dialog)).toBe(true);
    expect(appRoot).toHaveAttribute("inert");
  });

  it("Escape in a confirm over an editor closes only the confirm", async () => {
    const user = userEvent.setup();
    const closeEditor = vi.fn();
    renderApp(<Editor onClose={closeEditor} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: 'Delete "Anna"?' })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit person" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Anna")).toBeInTheDocument();
    expect(closeEditor).not.toHaveBeenCalled();

    // With the confirm gone the editor is the top again, and Escape is its.
    await user.keyboard("{Escape}");
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });

  it("Escape closes only the most recently opened of two sibling modals", async () => {
    const user = userEvent.setup();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const page = (second: boolean) => (
      <>
        <Modal title="First" onClose={closeFirst}><p>1</p></Modal>
        {second && <Modal title="Second" onClose={closeSecond}><p>2</p></Modal>}
      </>
    );
    const { rerender } = renderApp(page(false));
    rerender(page(true));

    await user.keyboard("{Escape}");
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeFirst).not.toHaveBeenCalled();
  });

  it("a backdrop click dismisses only the topmost modal", async () => {
    const user = userEvent.setup();
    const closeEditor = vi.fn();
    renderApp(<Editor onClose={closeEditor} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    // The editor's backdrop is underneath: pressing it does nothing while the confirm is up.
    fireEvent.mouseDown(backdropOf(screen.getByRole("dialog", { name: "Edit person" })));
    expect(closeEditor).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    // A press inside the confirm is not a backdrop press.
    fireEvent.mouseDown(screen.getByText("Her photos stay in the gallery."));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.mouseDown(backdropOf(screen.getByRole("alertdialog")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(closeEditor).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdropOf(screen.getByRole("dialog", { name: "Edit person" })));
    expect(closeEditor).toHaveBeenCalledTimes(1);
  });

  it("busy blocks Escape, the backdrop and the close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderApp(<Modal variant="panel" title="Saving" busy onClose={onClose}><p>Working</p></Modal>);

    await user.keyboard("{Escape}");
    fireEvent.mouseDown(backdropOf(screen.getByRole("dialog")));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a busy confirm swallows Escape rather than passing it to the editor underneath", async () => {
    const user = userEvent.setup();
    const closeEditor = vi.fn();
    const { rerender } = renderApp(<Editor onClose={closeEditor} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    rerender(<Editor onClose={closeEditor} confirmBusy />);

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(closeEditor).not.toHaveBeenCalled();
  });

  it("an Escape a control inside has already handled does not close the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderApp(
      <Modal title="Rename" onClose={onClose}>
        <input
          aria-label="Name"
          autoFocus
          onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
        />
      </Modal>
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an Escape stopped inside (Add to album's inline create) does not close the dialog", async () => {
    // AddToAlbumModal / AddToCollectionModal / AddToSlideshowModal cancel their
    // inline "new …" field this way. Through the portal React listens on the
    // dialog's own container, so the stop still happens before `document`.
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderApp(
      <Modal title="Add to album" onClose={onClose}>
        <input
          aria-label="New album"
          autoFocus
          onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
        />
      </Modal>
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  describe("focus", () => {
    it("goes to an autoFocus control", () => {
      renderApp(
        <Modal title="New tag" onClose={vi.fn()}>
          <button type="button">Help</button>
          <input aria-label="Tag name" autoFocus />
        </Modal>
      );
      expect(screen.getByRole("textbox", { name: "Tag name" })).toHaveFocus();
    });

    it("goes to a [data-autofocus] control", () => {
      renderApp(
        <Modal title="Pick one" onClose={vi.fn()}>
          <button type="button">First</button>
          <button type="button" data-autofocus="">Second</button>
        </Modal>
      );
      expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    });

    it("otherwise goes to the first control in the body, not the panel's ✕", () => {
      renderApp(
        <Modal variant="panel" title="Edit" onClose={vi.fn()}>
          <button type="button">Details</button>
          <button type="button">Photos</button>
        </Modal>
      );
      expect(screen.getByRole("button", { name: "Details" })).toHaveFocus();
    });

    it("goes to the dialog itself when it has no controls", () => {
      renderApp(<Modal title="Just so you know" onClose={vi.fn()}><p>Nothing to press.</p></Modal>);
      expect(screen.getByRole("dialog")).toHaveFocus();
    });

    it("returns to the control that opened the modal when it closes", async () => {
      const user = userEvent.setup();
      renderApp(
        <Page>
          {(close) => (
            <Modal title="New tag" onClose={close}>
              <input aria-label="Tag name" autoFocus />
            </Modal>
          )}
        </Page>
      );
      const trigger = screen.getByRole("button", { name: "Open" });
      await user.click(trigger);
      expect(screen.getByRole("textbox", { name: "Tag name" })).toHaveFocus();
      expect(appRoot).toHaveAttribute("inert");

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(appRoot).not.toHaveAttribute("inert");
      await waitFor(() => expect(trigger).toHaveFocus());
    });

    it("returns from a confirm to the editor control that opened it", async () => {
      const user = userEvent.setup();
      renderApp(<Editor onClose={vi.fn()} />);
      const del = screen.getByRole("button", { name: "Delete" });
      await user.click(del);
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(del).toHaveFocus());
      // The editor is still open, so the page stays inert.
      expect(appRoot).toHaveAttribute("inert");
    });

    it("returns to the page when a confirm closes its editor along with itself", async () => {
      const user = userEvent.setup();
      function Flow() {
        const [editing, setEditing] = useState(false);
        const [confirming, setConfirming] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setEditing(true)}>Edit</button>
            {editing && (
              <Modal variant="panel" title="Edit person" onClose={() => setEditing(false)}>
                <Button variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
                {confirming && (
                  <ConfirmDialog
                    title="Delete?"
                    confirmLabel="Delete person"
                    danger
                    onConfirm={() => { setConfirming(false); setEditing(false); }}
                    onCancel={() => setConfirming(false)}
                  >
                    Gone for good.
                  </ConfirmDialog>
                )}
              </Modal>
            )}
          </>
        );
      }
      renderApp(<Flow />);
      const edit = screen.getByRole("button", { name: "Edit" });
      await user.click(edit);
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Delete person" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(appRoot).not.toHaveAttribute("inert");
      await waitFor(() => expect(edit).toHaveFocus());
    });

    it("wraps Tab and Shift+Tab inside the dialog", async () => {
      const user = userEvent.setup();
      renderApp(
        <>
          <button type="button">Behind</button>
          <Modal title="Three" onClose={vi.fn()}>
            <button type="button">One</button>
            <button type="button">Two</button>
            <button type="button">Three</button>
          </Modal>
        </>
      );
      const one = screen.getByRole("button", { name: "One" });
      const two = screen.getByRole("button", { name: "Two" });
      const three = screen.getByRole("button", { name: "Three" });
      expect(one).toHaveFocus();

      await user.tab();
      expect(two).toHaveFocus();
      await user.tab();
      expect(three).toHaveFocus();
      await user.tab();
      expect(one).toHaveFocus();

      await user.tab({ shift: true });
      expect(three).toHaveFocus();
    });

    it("pulls focus back in on Tab when it has dropped to the page", async () => {
      const user = userEvent.setup();
      renderApp(
        <>
          {/* First in document order: a plain Tab from <body> would land here. */}
          <button type="button">Behind</button>
          <Modal title="Two" onClose={vi.fn()}>
            <button type="button">One</button>
            <button type="button">Two</button>
          </Modal>
        </>
      );
      (document.activeElement as HTMLElement).blur();
      expect(document.body).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("button", { name: "One" })).toHaveFocus();
    });

    it("keeps Tab on the only focusable thing when the dialog has no controls", async () => {
      const user = userEvent.setup();
      renderApp(<Modal title="Note" onClose={vi.fn()}><p>Read me.</p></Modal>);
      const dialog = screen.getByRole("dialog");
      await user.tab();
      expect(dialog).toHaveFocus();
      await user.tab({ shift: true });
      expect(dialog).toHaveFocus();
    });

    it("traps Tab in the confirm, not the editor under it", async () => {
      const user = userEvent.setup();
      renderApp(<Editor onClose={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Delete" }));
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const confirm = screen.getByRole("button", { name: "Delete person" });
      expect(cancel).toHaveFocus();

      await user.tab();
      expect(confirm).toHaveFocus();
      await user.tab();
      expect(cancel).toHaveFocus();
    });
  });
});
