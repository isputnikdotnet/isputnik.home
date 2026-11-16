import { useCallback, useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { AccessControl, type AccessInherited } from "../../shared/AccessControl";
import { AccessDialog } from "../../shared/AccessDialog";
import { Button } from "../../shared/Button";
import { PeopleReviewModal } from "../control/access/PeopleReviewModal";
import type { PersonShareCounts, SubjectType } from "../control/access/types";

// "Access to photos of Ivan" — the same grants as a person's Access dialog
// (docs/people-sharing-plan.md), seen from the person in the photos. Admins only.
// The standard access window (shared/AccessDialog, owner 2026-11-16), on/off: a
// switch per member or group. Who sees this person another way — their own
// account, or a branch of the family tree — is said on their row, not switched
// here (it is set on their Access page, or on the branch).
type Subject = { subjectType: SubjectType; subjectId: string; name: string };
type ViaBranch = Subject & { branchId: string; branchName: string };

export function PersonSharingModal({ person, onClose }: { person: { id: string; name: string }; onClose: () => void }) {
  const { t } = useTranslation(["common", "gallery", "controlAdmin"]);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [counts, setCounts] = useState<PersonShareCounts | null>(null);
  const [self, setSelf] = useState<{ userId: string; name: string; showPhotos: boolean } | null>(null);
  const [viaBranches, setViaBranches] = useState<ViaBranch[]>([]);
  const [candidates, setCandidates] = useState<{ users: { id: string; name: string }[]; groups: { id: string; name: string }[] }>({ users: [], groups: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<{ subjects: Subject[]; counts: PersonShareCounts; self: { userId: string; name: string; showPhotos: boolean } | null; viaBranches: ViaBranch[] }>(`/api/library/gallery/people/${person.id}/sharing`);
    setViaBranches(payload.viaBranches ?? []);
    setSubjects(payload.subjects);
    setCounts(payload.counts);
    setSelf(payload.self);
  }, [person.id]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("gallery:people.sharing.errors.load")));
    Promise.all([
      api<{ groups: { id: string; name: string }[] }>("/api/groups"),
      api<{ users: { id: string; displayName: string; role: string }[] }>("/api/users")
    ]).then(([groups, users]) => setCandidates({
      // Admins see every photo already; the built-in groups are not choices here.
      groups: groups.groups.filter((g) => g.id !== "grp-everyone" && g.id !== "grp-system-admins").map((g) => ({ id: g.id, name: g.name })),
      users: users.users.filter((u) => u.role !== "admin").map((u) => ({ id: u.id, name: u.displayName }))
    })).catch(() => setCandidates({ users: [], groups: [] }));
  }, [load, t]);

  const change = async (subjectType: SubjectType, subjectId: string, granted: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/library/gallery/people/${person.id}/sharing/${subjectType}/${encodeURIComponent(subjectId)}`, { method: granted ? "PUT" : "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:people.sharing.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  // Seen another way: their own account, or a branch of the tree.
  const inherited: AccessInherited[] = [
    ...(self ? [{ subjectId: self.userId, name: self.name, note: self.showPhotos ? t("gallery:people.sharing.selfSees") : t("gallery:people.sharing.selfLinked") }] : []),
    ...viaBranches.map((row) => ({ subjectId: row.subjectId, subjectType: row.subjectType, name: row.name, note: t("gallery:people.sharing.viaBranch", { branch: row.branchName }) }))
  ];

  return (
    <>
      <AccessDialog
        title={t("gallery:people.sharing.title", { name: person.name })}
        intro={t("gallery:people.sharing.hint", { name: person.name })}
        icon={<Share2 size={20} />}
        error={error}
        errorTitle={t("gallery:people.sharing.errors.title")}
        busy={busy}
        onClose={onClose}
      >
        {counts && (
          <div className="ax-bulk">
            <strong>
              {t("controlAdmin:access.photos.count", { count: counts.shared })}
              {counts.excluded > 0 && <small> · {t("controlAdmin:access.photos.excluded", { count: counts.excluded })}</small>}
            </strong>
            {counts.toReview > 0
              ? <Button variant="secondary" compact onClick={() => setReviewing(true)}>{t("controlAdmin:access.photos.review", { count: counts.toReview })}</Button>
              : <small className="muted">{t("controlAdmin:access.photos.allConfirmed")}</small>}
          </div>
        )}
        {subjects && (
          <AccessControl
            roles={[]}
            members={subjects.map((subject) => ({ subjectType: subject.subjectType, subjectId: subject.subjectId, name: subject.name, role: "" }))}
            candidates={candidates}
            inherited={inherited}
            busy={busy}
            emptyHint={t("gallery:people.sharing.nobody")}
            onGrant={(subjectType, subjectId) => change(subjectType, subjectId, true)}
            onRevoke={(subjectType, subjectId) => change(subjectType, subjectId, false)}
          />
        )}
      </AccessDialog>
      {reviewing && (
        <PeopleReviewModal person={person} onClose={() => setReviewing(false)} onDone={() => { setReviewing(false); void load(); }} />
      )}
    </>
  );
}
