import { Download, FileText, Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/Button";
import { Modal } from "../../shared/Modal";

// Two ways to take the tree out: a GEDCOM file for other genealogy programs, or
// a package for another isputnik.home server, which also carries portraits,
// photos, pins, other-language names and branch tags. Both are downloads;
// the package is admin-only (the server checks), so the button is offered only
// when the caller says so.
export function FamilyExportModal({
  canExportPackage,
  onClose
}: {
  canExportPackage: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const download = (url: string) => {
    window.location.assign(url);
    onClose();
  };
  return (
    <Modal variant="card" title={t("family:exportChoice.title")} onClose={onClose}>
      <div className="ft-export-choices">
        <section className="ft-export-choice">
          <h3><FileText size={18} aria-hidden="true" /> {t("family:exportChoice.gedcomTitle")}</h3>
          <p>{t("family:exportChoice.gedcomBody")}</p>
          <Button variant="secondary" onClick={() => download("/api/family-tree/export")}>
            <Download size={16} aria-hidden="true" />
            {t("family:exportChoice.gedcomButton")}
          </Button>
        </section>
        {canExportPackage && (
          <section className="ft-export-choice">
            <h3><Package size={18} aria-hidden="true" /> {t("family:exportChoice.packageTitle")}</h3>
            <p>{t("family:exportChoice.packageBody")}</p>
            <Button variant="primary" onClick={() => download("/api/family-tree/export/package")}>
              <Download size={16} aria-hidden="true" />
              {t("family:exportChoice.packageButton")}
            </Button>
          </section>
        )}
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
