import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { Modal } from "./Modal";

// The frame every access window opens in (owner, 2026-11-16; redesigned 2026-11-19):
// "Access to …" and a line saying what it is about, an error when a save fails, the
// shared AccessControl (which ends in "Changes are saved automatically" and the roles), and Close. Callers
// pass the AccessControl (with their roles and requests) as children; the frame is
// the same everywhere.

export function AccessDialog({ title, intro, icon, error, errorTitle, busy = false, onClose, children }: {
  title: string;
  /** One short line under the title: what this access is to. */
  intro?: ReactNode;
  /** The header's icon; people by default. */
  icon?: ReactNode;
  error?: string;
  errorTitle?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(["common"]);
  return (
    <Modal title={title} subtitle={intro} icon={icon ?? <Users size={20} />} className="ax-modal" busy={busy} onClose={onClose}>
      {error && <MessageBox tone="error" title={errorTitle ?? t("common:access.saveFailed")}>{error}</MessageBox>}
      {children}
      <div className="ax-modal-foot">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.close")}</Button>
      </div>
    </Modal>
  );
}
