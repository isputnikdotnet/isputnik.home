import React from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { MessageBox } from "./MessageBox";

// The single way to ask "are you sure?". Title is a question naming the
// object ("Delete invite link?"); children explain the consequence; the
// confirm label is an explicit verb, never "OK"/"Yes".
export function ConfirmDialog({
  title,
  confirmLabel,
  busyLabel,
  confirmIcon,
  danger = false,
  busy = false,
  rich = false,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
  children
}: {
  title: string;
  /** Verb phrase, e.g. "Delete", "Remove from group". */
  confirmLabel: string;
  /** Confirm-button text while busy, e.g. "Deleting…". Defaults to confirmLabel. */
  busyLabel?: string;
  /** Optional icon rendered before the confirm label. */
  confirmIcon?: React.ReactNode;
  /** Destructive action: filled danger confirm button + alertdialog role. */
  danger?: boolean;
  busy?: boolean;
  /** Children already contain block markup (<p>…); skip the default <p> wrapper. */
  rich?: boolean;
  /** The action can't go ahead — the children say why. Distinct from `busy`: that one
   *  means "wait", this one means "not as things stand". Cancel stays available either
   *  way, so the dialog is never a dead end. */
  confirmDisabled?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal variant="card" title={title} alert={danger} busy={busy} onClose={onCancel}>
      {rich ? children : <p>{children}</p>}
      {error && <MessageBox tone="error" title="Action failed">{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy || confirmDisabled}>
          {confirmIcon}
          {busy ? busyLabel ?? confirmLabel : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
