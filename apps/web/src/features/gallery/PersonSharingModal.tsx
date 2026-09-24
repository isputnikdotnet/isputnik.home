import { useCallback, useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectField } from "../../shared/SelectField";
import { groupAccessHref, userAccessHref } from "../control/links";
import { PeopleReviewModal } from "../control/access/PeopleReviewModal";
import type { PersonShareCounts, SubjectType } from "../control/access/types";

// "Who can see photos of Ivan" — the same grants as a person's Access dialog
// (docs/people-sharing-plan.md), seen from the person in the photos. Admins only.
type Subject = { subjectType: SubjectType; subjectId: string; name: string };

export function PersonSharingModal({ person, onClose }: { person: { id: string; name: string }; onClose: () => void }) {
  const { t } = useTranslation(["common", "gallery", "controlAdmin"]);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [counts, setCounts] = useState<PersonShareCounts | null>(null);
  // The account this person IS (Q1) — set on their Access dialog, not here.
  const [self, setSelf] = useState<{ userId: string; name: string; showPhotos: boolean } | null>(null);
  // Who gets this person through a branch of the tree (Q2) — changed on the branch.
  const [viaBranches, setViaBranches] = useState<(Subject & { branchId: string; branchName: string })[]>([]);
  const [candidates, setCandidates] = useState<Subject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<{ subjects: Subject[]; counts: PersonShareCounts; self: { userId: string; name: string; showPhotos: boolean } | null; viaBranches: (Subject & { branchId: string; branchName: string })[] }>(`/api/library/gallery/people/${person.id}/sharing`);
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
    ]).then(([groups, users]) => setCandidates([
      ...groups.groups.filter((g) => g.id !== "grp-everyone" && g.id !== "grp-system-admins").map((g) => ({ subjectType: "group" as const, subjectId: g.id, name: g.name })),
      ...users.users.filter((u) => u.role !== "admin").map((u) => ({ subjectType: "user" as const, subjectId: u.id, name: u.displayName }))
    ])).catch(() => setCandidates([]));
  }, [load, t]);

  const change = async (subject: { subjectType: SubjectType; subjectId: string }, granted: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/library/gallery/people/${person.id}/sharing/${subject.subjectType}/${encodeURIComponent(subject.subjectId)}`, { method: granted ? "PUT" : "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:people.sharing.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const shared = new Set((subjects ?? []).map((s) => `${s.subjectType}:${s.subjectId}`));
  const addable = candidates.filter((c) => !shared.has(`${c.subjectType}:${c.subjectId}`));
  const open = (subject: Subject) => {
    onClose();
    navigate(subject.subjectType === "user" ? userAccessHref(subject.subjectId, "photos") : groupAccessHref(subject.subjectId, "photos"));
  };

  return (
    <>
      <Modal title={t("gallery:people.sharing.title", { name: person.name })} icon={<Share2 size={18} />} className="person-sharing-modal" busy={busy} onClose={onClose}>
        <p className="access-muted">{t("gallery:people.sharing.hint", { name: person.name })}</p>
        {error && <MessageBox tone="error" title={t("gallery:people.sharing.errors.title")}>{error}</MessageBox>}
        {counts && (
          <div className="access-row access-row-two">
            <span className="access-row-name">
              {t("controlAdmin:access.photos.count", { count: counts.shared })}
              {counts.excluded > 0 && <small>{t("controlAdmin:access.photos.excluded", { count: counts.excluded })}</small>}
            </span>
            {counts.toReview > 0
              ? <Button variant="secondary" compact onClick={() => setReviewing(true)}>{t("controlAdmin:access.photos.review", { count: counts.toReview })}</Button>
              : <span className="access-muted">{t("controlAdmin:access.photos.allConfirmed")}</span>}
          </div>
        )}
        <div className="access-rows">
          {self && (
            <div className="access-row access-row-two">
              <Button variant="text" className="user-name-link" onClick={() => open({ subjectType: "user", subjectId: self.userId, name: self.name })}>
                {self.name}
              </Button>
              <span className="access-muted">{self.showPhotos ? t("gallery:people.sharing.selfSees") : t("gallery:people.sharing.selfLinked")}</span>
            </div>
          )}
          {viaBranches.map((row) => (
            <div className="access-row access-row-two" key={`${row.branchId}:${row.subjectType}:${row.subjectId}`}>
              <Button variant="text" className="user-name-link" onClick={() => open(row)}>
                {row.subjectType === "group" ? t("gallery:people.sharing.group", { name: row.name }) : row.name}
              </Button>
              <span className="access-muted">{t("gallery:people.sharing.viaBranch", { branch: row.branchName })}</span>
            </div>
          ))}
          {subjects && subjects.length === 0 && !self && viaBranches.length === 0 && <p className="access-muted">{t("gallery:people.sharing.nobody")}</p>}
          {(subjects ?? []).map((subject) => (
            <div className="access-row access-row-two" key={`${subject.subjectType}:${subject.subjectId}`}>
              <Button variant="text" className="user-name-link" onClick={() => open(subject)}>
                {subject.subjectType === "group" ? t("gallery:people.sharing.group", { name: subject.name }) : subject.name}
              </Button>
              <Button variant="secondary" compact disabled={busy} onClick={() => void change(subject, false)}>{t("controlAdmin:access.remove")}</Button>
            </div>
          ))}
        </div>
        {addable.length > 0 && (
          <div className="access-add">
            <SelectField
              label={t("gallery:people.sharing.add")}
              value=""
              disabled={busy}
              onChange={(key) => {
                const [subjectType, subjectId] = key.split(":");
                if (subjectId) void change({ subjectType: subjectType as SubjectType, subjectId }, true);
              }}
              options={[
                { value: "", label: t("gallery:people.sharing.choose") },
                ...addable.map((c) => ({ value: `${c.subjectType}:${c.subjectId}`, label: c.subjectType === "group" ? t("gallery:people.sharing.group", { name: c.name }) : c.name }))
              ]}
            />
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.close")}</Button>
        </div>
      </Modal>
      {reviewing && (
        <PeopleReviewModal person={person} onClose={() => setReviewing(false)} onDone={() => { setReviewing(false); void load(); }} />
      )}
    </>
  );
}
