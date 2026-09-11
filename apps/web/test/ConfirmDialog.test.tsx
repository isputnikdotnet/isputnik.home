import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/shared/Button";
import { ConfirmDialog } from "../src/shared/ConfirmDialog";
import { Modal } from "../src/shared/Modal";

// ConfirmDialog is the one way the app asks "are you sure?". It holds focus on
// Cancel (or on the challenge box), dismisses on Escape and its backdrop unless
// busy, and — the reason this file exists alongside Modal's — when it is opened
// over an editor, cancelling it never takes the editor down with it.

let appRoot: HTMLElement;

beforeEach(() => {
  appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.appendChild(appRoot);
});

const renderApp = (ui: React.ReactElement) => render(ui, { container: appRoot });

function confirm(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = renderApp(
    <ConfirmDialog
      title='Delete "Holiday 2019"?'
      confirmLabel="Delete album"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      {props.children ?? "The photos stay in the gallery."}
    </ConfirmDialog>
  );
  return { ...view, onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("asks with its title, states the consequence, and offers Cancel and the verb", () => {
    confirm();
    const dialog = screen.getByRole("dialog", { name: 'Delete "Holiday 2019"?' });
    expect(dialog).toHaveTextContent("The photos stay in the gallery.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete album" })).toBeInTheDocument();
  });

  it("is an alertdialog with a danger confirm when destructive", () => {
    confirm({ danger: true });
    expect(screen.getByRole("alertdialog", { name: 'Delete "Holiday 2019"?' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete album" })).toHaveClass("danger-button");
  });

  it("puts focus on Cancel, so a reflexive Enter cancels", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = confirm({ danger: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs onConfirm from the confirm button and onCancel from Cancel", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = confirm();
    await user.click(screen.getByRole("button", { name: "Delete album" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape and on a backdrop press", async () => {
    const user = userEvent.setup();
    const { onCancel } = confirm();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole("dialog").closest(".modal-backdrop")!);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("while busy: shows the busy label, disables both buttons, and ignores Escape and the backdrop", async () => {
    const user = userEvent.setup();
    const { onCancel } = confirm({ busy: true, busyLabel: "Deleting…" });
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").closest(".modal-backdrop")!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows a failed attempt inline", () => {
    confirm({ error: "The album is locked." });
    expect(screen.getByText("Action failed")).toBeInTheDocument();
    expect(screen.getByText("The album is locked.")).toBeInTheDocument();
  });

  it("with a challenge, focuses the box and keeps the verb disabled until the value is typed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = confirm({ challenge: { value: "28", label: "Type 28 to confirm" } });
    const box = screen.getByRole("textbox", { name: "Type 28 to confirm" });
    const verb = screen.getByRole("button", { name: "Delete album" });
    expect(box).toHaveFocus();
    expect(verb).toBeDisabled();

    await user.type(box, "2");
    expect(verb).toBeDisabled();
    await user.type(box, "8 ");
    expect(verb).toBeEnabled();
    await user.click(verb);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab between its own buttons", async () => {
    const user = userEvent.setup();
    confirm();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const verb = screen.getByRole("button", { name: "Delete album" });
    await user.tab();
    expect(verb).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(verb).toHaveFocus();
  });

  describe("over an editor", () => {
    function Editor({ onCloseEditor, onDeleted }: { onCloseEditor: () => void; onDeleted: () => void }) {
      const [asking, setAsking] = useState(false);
      return (
        <Modal variant="panel" title="Edit album" onClose={onCloseEditor}>
          <label>
            Album name
            <input defaultValue="Holiday 2019" />
          </label>
          <Button variant="danger" onClick={() => setAsking(true)}>Delete</Button>
          {asking && (
            <ConfirmDialog
              title='Delete "Holiday 2019"?'
              confirmLabel="Delete album"
              danger
              onConfirm={() => { setAsking(false); onDeleted(); }}
              onCancel={() => setAsking(false)}
            >
              The photos stay in the gallery.
            </ConfirmDialog>
          )}
        </Modal>
      );
    }

    it("Escape cancels the confirm and leaves the editor and its unsaved form alone", async () => {
      const user = userEvent.setup();
      const onCloseEditor = vi.fn();
      renderApp(<Editor onCloseEditor={onCloseEditor} onDeleted={vi.fn()} />);

      const name = screen.getByRole("textbox", { name: "Album name" });
      await user.clear(name);
      await user.type(name, "Holiday 2019 (Crete)");
      const del = screen.getByRole("button", { name: "Delete" });
      await user.click(del);
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(onCloseEditor).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Album name" })).toHaveValue("Holiday 2019 (Crete)");
      await waitFor(() => expect(del).toHaveFocus());
    });

    it("a backdrop press cancels the confirm only", async () => {
      const user = userEvent.setup();
      const onCloseEditor = vi.fn();
      renderApp(<Editor onCloseEditor={onCloseEditor} onDeleted={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Delete" }));

      fireEvent.mouseDown(screen.getByRole("alertdialog").closest(".modal-backdrop")!);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByRole("dialog", { name: "Edit album" })).toBeInTheDocument();
      expect(onCloseEditor).not.toHaveBeenCalled();
    });

    it("confirming runs the action without closing the editor", async () => {
      const user = userEvent.setup();
      const onCloseEditor = vi.fn();
      const onDeleted = vi.fn();
      renderApp(<Editor onCloseEditor={onCloseEditor} onDeleted={onDeleted} />);
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Delete album" }));
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(onCloseEditor).not.toHaveBeenCalled();
      expect(appRoot).toHaveAttribute("inert");
    });
  });
});
