import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { MessageBox } from "./MessageBox";

/** Make the reader type something back before the confirm button will work.
 *
 *  For the handful of actions that destroy a lot at once and cannot be undone, where
 *  the cost of a mis-click is far higher than the cost of a moment's friction. The
 *  value should be something the dialog itself already shows — a count, a name — so
 *  answering means having read it. Reach for this rarely: on an ordinary destructive
 *  action it is noise, and noise is what teaches people to click through warnings. */
export interface ConfirmChallenge {
  /** What must be typed, verbatim (trimmed, case-sensitive). */
  value: string;
  /** Prompt above the box. Say what to type: "Type 28 to confirm". */
  label: React.ReactNode;
}

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
  challenge,
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
  /** Require the reader to type `value` before confirming. See ConfirmChallenge. */
  challenge?: ConfirmChallenge;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const challengeId = useId();
  // Case-sensitive, but forgiving of stray whitespace — a copied count can arrive
  // with a space on it, and refusing that teaches nothing.
  const challengeMet = !challenge || typed.trim() === challenge.value;

  return (
    <Modal variant="card" title={title} alert={danger} busy={busy} onClose={onCancel}>
      {rich ? children : <p>{children}</p>}
      {challenge && (
        <label className="field confirm-challenge" htmlFor={challengeId}>
          <span>{challenge.label}</span>
          <input
            id={challengeId}
            type="text"
            value={typed}
            disabled={busy}
            autoComplete="off"
            // The box is the thing to fill in, so it takes the focus that Cancel
            // otherwise holds. Nothing is lost: an errant Enter lands in an empty
            // field, and the confirm button behind it is disabled until it isn't.
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      {error && <MessageBox tone="error" title={t("errors.actionFailed")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus={!challenge}>
          {t("common.cancel")}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={busy || confirmDisabled || !challengeMet}
        >
          {confirmIcon}
          {busy ? busyLabel ?? confirmLabel : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
