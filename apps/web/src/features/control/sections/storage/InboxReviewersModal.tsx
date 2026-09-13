import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { api } from "../../../../api";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl, type AccessRole } from "../../../../shared/AccessControl";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import "../../../../styles/system-data.css";

type Level = "details" | "keep";

interface ReviewersPayload {
  reviewers: { subjectType: "user" | "group"; subjectId: string; name: string; email: string | null; level: Level; missing: boolean }[];
  everyone: Level | null;
  candidates: { users: { id: string; name: string }[]; groups: { id: string; name: string }[] };
}

const REVIEWERS_URL = "/api/storage/app-storage/parts/inbox/reviewers";

// Who reviews the Photo Inbox besides the admins (docs/system-data-plan.md, phase 4,
// decision 21). The Inbox has no library access rules: this list is all there is.
// The box is `shared/AccessControl`, with the Inbox's two levels as its vocabulary.
export function InboxReviewersModal({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [data, setData] = useState<ReviewersPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ReviewersPayload>(REVIEWERS_URL)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.reviewers.saveError")));
  }, [t]);
  useEffect(load, [load]);

  const run = async (work: () => Promise<ReviewersPayload>) => {
    setBusy(true);
    setError("");
    try {
      setData(await work());
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.reviewers.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const level = (value: Level): AccessRole => ({
    value,
    label: t(`controlAdmin:appStorage.reviewers.levels.${value}`),
    tagline: t(`controlAdmin:appStorage.reviewers.taglines.${value}`),
    dot: ACCESS_ROLE_DOT[value === "keep" ? "manager" : "contributor"]
  });
  const levels = [level("details"), level("keep")];
  const none: AccessRole = { value: ACCESS_NONE, label: t("common:access.noAccess"), tagline: "", dot: ACCESS_ROLE_DOT.none };

  return (
    <Modal
      variant="panel"
      title={t("controlAdmin:appStorage.reviewers.title")}
      icon={<ShieldCheck size={24} />}
      className="inbox-reviewers-modal"
      busy={busy}
      onClose={onClose}
    >
      <div className="modal-tab-content inbox-reviewers">
        <p className="inbox-reviewers-intro">{t("controlAdmin:appStorage.reviewers.intro")}</p>
        {error && <MessageBox tone="error" title={t("controlAdmin:appStorage.reviewers.saveErrorTitle")}>{error}</MessageBox>}
        {!data && !error && <p className="management-empty">{t("controlAdmin:ui.loading")}</p>}
        {data && (
          <AccessControl
            roles={levels}
            members={data.reviewers.map((reviewer) => ({
              subjectType: reviewer.subjectType,
              subjectId: reviewer.subjectId,
              name: reviewer.name,
              sub: reviewer.subjectType === "user" ? reviewer.email ?? undefined : undefined,
              role: reviewer.level,
              missing: reviewer.missing
            }))}
            candidates={data.candidates}
            everyone={{
              role: data.everyone,
              hint: t("controlAdmin:appStorage.reviewers.everyoneHint"),
              options: [none, ...levels],
              publicTag: false,
              onChange: (next) => void run(() => api<ReviewersPayload>(`${REVIEWERS_URL}/everyone`, { method: "PUT", body: JSON.stringify({ level: next }) }))
            }}
            busy={busy}
            emptyHint={t("controlAdmin:appStorage.reviewers.nobody")}
            onGrant={(subjectType, subjectId, granted) => void run(() =>
              api<ReviewersPayload>(REVIEWERS_URL, { method: "POST", body: JSON.stringify({ subjectType, subjectId, level: granted }) }))}
            onRevoke={(subjectType, subjectId) => void run(() =>
              api<ReviewersPayload>(`${REVIEWERS_URL}/${subjectType}/${encodeURIComponent(subjectId)}`, { method: "DELETE" }))}
          />
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
