import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { Modal } from "./Modal";

// The frame every access window opens in (owner, 2026-11-16): one compact popup,
// "Access to …", an optional line saying what it is about, an error when a save
// fails, the shared AccessControl, and Close. Callers pass the AccessControl (with
// their roles and requests) as children; the frame is the same everywhere.

export function AccessDialog({ title, intro, error, errorTitle, busy = false, onClose, children }: {
  title: string;
  /** One short line under the title. */
  intro?: ReactNode;
  error?: string;
  errorTitle?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <Modal title={title} className="ax-modal" busy={busy} onClose={onClose}>
      {intro && <p className="ax-intro">{intro}</p>}
      {error && <MessageBox tone="error" title={errorTitle ?? t("common:access.saveFailed")}>{error}</MessageBox>}
      {children}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.close")}</Button>
      </div>
    </Modal>
  );
}
