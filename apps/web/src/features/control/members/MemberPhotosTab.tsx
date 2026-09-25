import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Images, MapPin, UserRound, UsersRound } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { SelectField } from "../../../shared/SelectField";
import type { AccessSubjectState } from "../access/AccessTabs";
import type { PeopleAccess } from "../access/types";

// The Photos of people tab of a member's page (docs/people-sharing-plan.md):
// photos of themselves (Q1), then the people and the tree branches (Q2) whose
// photos they see, each a table with Review and Remove, and last what it adds
// up to in their Gallery, with the location switch.

export function MemberPhotosTab({ state, name, onReview, onOpenAccount, onOpenGroup }: {
  state: AccessSubjectState;
  name: string;
  onReview: (person: { id: string; name: string }) => void;
  /** Their face is chosen on Account; this goes there. */
  onOpenAccount: () => void;
  onOpenGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, people, busy, write, base, del } = state;
  const [all, setAll] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ people: { id: string; name: string }[] }>("/api/library/gallery/people")
      .then((payload) => setAll(payload.people.filter((person) => person.name.trim())))
      .catch(() => setAll([]));
  }, []);
  if (!overview || !people) return null;

  const onSelf = (personId: string, showPhotos: boolean) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos }) }));
  const onGrant = (personId: string) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, { method: "PUT" }));
  const onRevoke = (personId: string) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, del));
  const onGrantBranch = (branchId: string) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, { method: "PUT" }));
  const onRevokeBranch = (branchId: string) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, del));
  const onLocation = (on: boolean) => void write(() => api(`/api/library/gallery/access/${base}/settings`, { method: "PUT", body: JSON.stringify({ showLocation: on }) }));

  const direct = new Set(people.people.filter((p) => p.direct).map((p) => p.id));
  const addable = all.filter((person) => !direct.has(person.id));
  const excluded = people.people.reduce((sum, p) => sum + p.counts.excluded, 0);
  const self = people.self ?? null;
  // Their own person, when seen only as themselves, sits with the switch that
  // shows it; granted as well, it stays in the list with a "themselves" note.
  const selfRow = people.people.find((p) => p.self && !p.direct && p.viaGroups.length === 0) ?? null;
  const others = people.people.filter((p) => p !== selfRow);
  const directBranches = new Set(people.branches.filter((b) => b.direct).map((b) => b.id));
  const addableBranches = people.allBranches.filter((b) => !directBranches.has(b.id));

  const via = (groups: { id: string; name: string }[]) => groups.length > 0 && (
    <small>
      {groups.map((group) => (
        <Button key={group.id} variant="text" compact onClick={() => onOpenGroup(group.id)}>
          {t("controlAdmin:access.photos.viaGroup", { group: group.name })}
        </Button>
      ))}
    </small>
  );

  const personRow = (person: PeopleAccess["people"][number]) => (
    <tr key={person.id}>
      <td>
        <span className="member-table-primary">
          <strong>{person.name}</strong>
          {person.self && person !== selfRow && <small>{t("controlAdmin:access.photos.selfBadge")}</small>}
          {via(person.viaGroups)}
        </span>
      </td>
      <td className="member-table-num">{t("controlAdmin:access.photos.count", { count: person.counts.shared })}</td>
      <td>
        {person.counts.toReview > 0
          ? <Button variant="secondary" compact disabled={busy} onClick={() => onReview(person)}>{t("controlAdmin:access.photos.review", { count: person.counts.toReview })}</Button>
          : <span className="access-muted">{t("controlAdmin:access.photos.allConfirmed")}</span>}
      </td>
      <td className="member-table-actions">
        {person.direct && (
          <Button variant="secondary" compact disabled={busy} onClick={() => onRevoke(person.id)}>{t("controlAdmin:access.remove")}</Button>
        )}
      </td>
    </tr>
  );

  return (
    <>
      <section className="member-card" aria-labelledby="member-self-title">
        <h2 id="member-self-title">
          <UserRound size={17} aria-hidden="true" />
          {t("controlAdmin:access.photos.selfTitle", { name })}
        </h2>
        <label className="member-toggle">
          <input type="checkbox" checked={self?.showPhotos ?? false} disabled={busy || !self} onChange={(event) => self && onSelf(self.personId, event.target.checked)} />
          <span>
            {t("controlAdmin:access.photos.selfShow")}
            <small>{self ? t("controlAdmin:access.photos.selfHintLinked", { name, face: self.name }) : t("controlAdmin:access.photos.selfHintUnlinked", { name })}</small>
          </span>
        </label>
        {!self && (
          <div className="member-toggle-action">
            <Button variant="text" compact onClick={onOpenAccount}>{t("controlAdmin:access.photos.selfLinkOnAccount")}</Button>
          </div>
        )}
        {selfRow && (
          <table className="member-table member-people">
            <tbody>{personRow(selfRow)}</tbody>
          </table>
        )}
      </section>

      <section className="member-card" aria-labelledby="member-people-title">
        <h2 id="member-people-title">
          <UsersRound size={17} aria-hidden="true" />
          {t("controlAdmin:access.photos.othersTitle")}
        </h2>
        <p className="access-muted">{t("controlAdmin:access.photos.hint", { name })}</p>
        {others.length === 0
          ? <p className="access-muted">{t("controlAdmin:access.photos.none")}</p>
          : (
            <table className="member-table member-people">
              <thead>
                <tr>
                  <th>{t("controlAdmin:member.photos.colPerson")}</th>
                  <th>{t("controlAdmin:member.photos.colPhotos")}</th>
                  <th>{t("controlAdmin:member.photos.colReview")}</th>
                  <th><span className="sr-only">{t("controlAdmin:member.photos.colActions")}</span></th>
                </tr>
              </thead>
              <tbody>{others.map(personRow)}</tbody>
            </table>
          )}
        {addable.length > 0 && (
          <div className="member-add-row">
            <SelectField
              label={t("controlAdmin:access.photos.add")}
              value=""
              disabled={busy}
              onChange={(personId) => { if (personId) onGrant(personId); }}
              options={[{ value: "", label: t("controlAdmin:access.photos.choose") }, ...addable.map((person) => ({ value: person.id, label: person.name }))]}
            />
          </div>
        )}
      </section>

      {people.allBranches.length > 0 && (
        <section className="member-card" aria-labelledby="member-branches-title">
          <h2 id="member-branches-title">
            <GitBranch size={17} aria-hidden="true" />
            {t("controlAdmin:access.photos.branchesTitle")}
          </h2>
          <p className="access-muted">{t("controlAdmin:access.photos.branchesHint", { name })}</p>
          {people.branches.length === 0
            ? <p className="access-muted">{t("controlAdmin:member.photos.noBranches")}</p>
            : (
              <table className="member-table member-people">
                <thead>
                  <tr>
                    <th>{t("controlAdmin:member.photos.colBranch")}</th>
                    <th>{t("controlAdmin:member.photos.colPeople")}</th>
                    <th>{t("controlAdmin:member.photos.colPhotos")}</th>
                    <th><span className="sr-only">{t("controlAdmin:member.photos.colActions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {people.branches.map((branch) => (
                    <tr key={branch.id}>
                      <td>
                        <span className="member-table-primary">
                          <strong>{branch.name}</strong>
                          {via(branch.viaGroups)}
                        </span>
                      </td>
                      <td className="member-table-num">{t("controlAdmin:access.photos.branchPeople", { count: branch.people })}</td>
                      <td className="member-table-num">{t("controlAdmin:access.photos.count", { count: branch.photos })}</td>
                      <td className="member-table-actions">
                        {branch.direct && (
                          <Button variant="secondary" compact disabled={busy} onClick={() => onRevokeBranch(branch.id)}>{t("controlAdmin:access.remove")}</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {addableBranches.length > 0 && (
            <div className="member-add-row">
              <SelectField
                label={t("controlAdmin:access.photos.addBranch")}
                value=""
                disabled={busy}
                onChange={(branchId) => { if (branchId) onGrantBranch(branchId); }}
                options={[{ value: "", label: t("controlAdmin:access.photos.chooseBranch") }, ...addableBranches.map((branch) => ({ value: branch.id, label: branch.name }))]}
              />
            </div>
          )}
        </section>
      )}

      <section className="member-card" aria-labelledby="member-gallery-title">
        <h2 id="member-gallery-title">
          <Images size={17} aria-hidden="true" />
          {t("controlAdmin:member.photos.galleryTitle")}
        </h2>
        <p className="member-gallery-total">
          {t("controlAdmin:access.photos.total", { count: people.photoCount, name })}
          {excluded > 0 && ` · ${t("controlAdmin:access.photos.excluded", { count: excluded })}`}
        </p>
        <label className="member-toggle">
          <input type="checkbox" checked={people.settings.showLocation} disabled={busy} onChange={(event) => onLocation(event.target.checked)} />
          <span>
            <MapPin size={14} aria-hidden="true" className="member-toggle-icon" />
            {t("controlAdmin:access.photos.location")}
            <small>{t("controlAdmin:access.photos.locationHint")}</small>
          </span>
        </label>
      </section>
    </>
  );
}
