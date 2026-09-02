import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ACCESS_NONE, ACCESS_ROLE_DOT, AccessControl, type AccessRole } from "../../shared/AccessControl";

interface AccessPayload {
  members: { subjectType: "user" | "group"; subjectId: string; role: string; name: string | null; email: string | null }[];
  everyoneRole: string | null;
  candidates: { users: { id: string; name: string }[]; groups: { id: string; name: string }[] };
}

/** What a grant can say. `deny` blocks whatever else would let someone in. */
const GRANT_ROLES = ["viewer", "contributor", "manager", "deny"] as const;
/** The household baseline is a narrower vocabulary — it can't deny anyone. */
const EVERYONE_ROLES = [ACCESS_NONE, "viewer", "contributor"] as const;

// Who may see this shelf (and therefore its stories), who may add to it, who
// runs it. The box itself is `shared/AccessControl` — this only supplies the
// collection's role vocabulary, its data, and the four calls that change it.
export function StoryCollectionAccessModal({
  collectionId,
  onClose
}: {
  collectionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    api<AccessPayload>(`/api/stories/collections/${collectionId}/access`)
      .then(setAccess)
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  };
  useEffect(load, [collectionId]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const role = (value: string): AccessRole => ({
    value,
    label: t(`stories:collections.roles.${value as "viewer"}`),
    tagline: t(`stories:collections.roleTaglines.${value as "viewer"}`),
    dot: ACCESS_ROLE_DOT[value]
  });

  // One generic word for the title, no object name and no explaining line under
  // it: the page behind already says which collection this is.
  return (
    <Modal
      variant="panel"
      title={t("common:access.title")}
      icon={<ShieldCheck size={24} />}
      className="story-access-modal"
      busy={busy}
      onClose={onClose}
    >
      <div className="modal-tab-content story-access">
        {error && <MessageBox tone="error" title={t("stories:errors.saveTitle")}>{error}</MessageBox>}

        {!access && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {access && (
          <AccessControl
            roles={GRANT_ROLES.map(role)}
            members={access.members.map((member) => ({
              subjectType: member.subjectType,
              subjectId: member.subjectId,
              role: member.role,
              name: member.name ?? member.subjectId,
              sub: member.subjectType === "user" ? member.email ?? undefined : undefined
            }))}
            candidates={access.candidates}
            everyone={{
              role: access.everyoneRole,
              hint: t("stories:collections.everyoneHint"),
              options: EVERYONE_ROLES.map(role),
              lockedHint: t("stories:collections.everyoneLocked"),
              onChange: (next) => void run(() => api(`/api/stories/collections/${collectionId}/access/everyone`, {
                method: "PUT",
                body: JSON.stringify({ role: next })
              }))
            }}
            busy={busy}
            onGrant={(subjectType, subjectId, granted) => void run(() =>
              api(`/api/stories/collections/${collectionId}/access`, {
                method: "POST",
                body: JSON.stringify({ subjectType, subjectId, role: granted })
              }))}
            onRevoke={(subjectType, subjectId) => void run(() =>
              api(`/api/stories/collections/${collectionId}/access/${subjectType}/${subjectId}`, { method: "DELETE" }))}
          />
        )}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
