import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe2, Trash2, UserPlus, Users } from "lucide-react";
import { Button } from "./Button";
import { MessageBox } from "./MessageBox";
import { avatarHue, avatarInitials } from "./utils";

/** One word in a surface's access vocabulary. */
export interface AccessRole {
  value: string;
  label: string;
  /** One line saying what the role may do — shown in the glossary. */
  tagline: string;
  /** The dot beside the role in its dropdown. */
  dot: string;
}

/** Somebody (or some group) already on the list. */
export interface AccessGrant {
  subjectType: "user" | "group";
  subjectId: string;
  name: string;
  /** Second line: an email, a member count, whatever the caller knows. */
  sub?: string;
  role: string;
  /** The user or group is gone — its role is frozen, removing it still works. */
  missing?: boolean;
}

export interface AccessCandidate {
  id: string;
  name: string;
}

/** The household baseline. Omit the whole prop for surfaces that have none. */
export interface AccessEveryone {
  /** null = no access. */
  role: string | null;
  /** The line under "Everyone" — what the baseline means here. */
  hint: string;
  /** Given = the baseline is editable, from this vocabulary. */
  options?: AccessRole[];
  onChange?: (role: string | null) => void;
  /** Tooltip on the locked button: why this row can't be removed / is fixed. */
  lockedHint?: string;
}

const DEFAULT_ROLE_DOTS = {
  viewer: "#3b82f6",
  member: "#8b5cf6",
  contributor: "#14b8a6",
  manager: "#f59e0b",
  deny: "#ef4444",
  none: "#94a3b8"
} as const;

/** The palette every access surface draws its role dots from, so one role
 *  reads the same colour in libraries, shelves and family branches. */
export const ACCESS_ROLE_DOT: Record<string, string> = DEFAULT_ROLE_DOTS;

/** The value the "no access" option carries — never sent as a role. */
export const ACCESS_NONE = "none";

// The role dropdown with its colour dot.
function RoleSelect({
  value,
  options,
  label,
  disabled,
  onChange
}: {
  value: string;
  options: AccessRole[];
  label: string;
  disabled?: boolean;
  onChange?: (role: string) => void;
}) {
  const dot = options.find((option) => option.value === value)?.dot ?? ACCESS_ROLE_DOT.none;
  return (
    <div className={`member-role-control${disabled ? " is-locked" : ""}`}>
      <span className="member-role-dot" style={{ background: dot }} aria-hidden="true" />
      <select
        value={value}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        aria-label={label}
      >
        {/* The name alone: what each role may do is spelled out once, in the
            glossary under the list, rather than truncated in every row. */}
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

// Who can see a thing, and what they may do with it — the one access surface
// the whole app shares. Libraries, story collections and family-tree branches
// all grant to the same two kinds of subject (people and groups) over the same
// baseline, so they get the same box; only the ROLE VOCABULARY and the data
// change, and both arrive as props.
//
// The caller owns the requests. This component renders what it is given and
// calls back — it never talks to the server itself, because each surface has
// its own endpoints and its own idea of an error.
export function AccessControl({
  roles,
  members,
  candidates,
  everyone,
  busy = false,
  defaultRole,
  onGrant,
  onRevoke,
  showLegend = true,
  emptyHint
}: {
  /** The vocabulary for grants, in the order it escalates. */
  roles: AccessRole[];
  members: AccessGrant[];
  /** Omit to hide the grant row (a read-only view of who has access). */
  candidates?: { users: AccessCandidate[]; groups: AccessCandidate[] };
  everyone?: AccessEveryone;
  busy?: boolean;
  /** Which role the grant row starts on. Defaults to the first listed. */
  defaultRole?: string;
  onGrant: (subjectType: "user" | "group", subjectId: string, role: string) => void;
  onRevoke: (subjectType: "user" | "group", subjectId: string) => void;
  showLegend?: boolean;
  /** Shown in place of the list when nobody has been granted anything. */
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common"]);
  const [subject, setSubject] = useState("");
  const [newRole, setNewRole] = useState(defaultRole ?? roles[0]?.value ?? "");

  const granted = new Set(members.map((member) => `${member.subjectType}:${member.subjectId}`));
  // One list, ordered by reach: the baseline, then groups, then individuals —
  // so the widest grant is read before the narrow ones it sits under. Nothing
  // labels the sections; the avatar says which kind a row is.
  const byName = (a: AccessGrant, b: AccessGrant) => a.name.localeCompare(b.name);
  const listed = [
    ...members.filter((member) => member.subjectType === "group").sort(byName),
    ...members.filter((member) => member.subjectType === "user").sort(byName)
  ];
  const freeUsers = candidates?.users.filter((candidate) => !granted.has(`user:${candidate.id}`)) ?? [];
  const freeGroups = candidates?.groups.filter((candidate) => !granted.has(`group:${candidate.id}`)) ?? [];

  const add = () => {
    const [subjectType, subjectId] = subject.split(":");
    if (subjectType !== "user" && subjectType !== "group") return;
    if (!subjectId) return;
    setSubject("");
    onGrant(subjectType, subjectId, newRole);
  };

  const row = (member: AccessGrant) => {
    const isGroup = member.subjectType === "group";
    return (
      <div className="member-row" key={`${member.subjectType}:${member.subjectId}`}>
        {isGroup ? (
          <span className="member-avatar member-avatar-neutral" aria-hidden="true"><Users size={18} /></span>
        ) : (
          <span
            className="member-avatar"
            style={{ background: `hsl(${avatarHue(member.name)}, 58%, 52%)` }}
            aria-hidden="true"
          >
            {avatarInitials(member.name)}
          </span>
        )}
        <div className="member-identity">
          <span className="member-name">
            {member.name}
            {member.missing && <span className="member-sub">{t("common:access.deleted")}</span>}
          </span>
          <span className="member-sub">
            {member.sub ?? (isGroup ? t("common:access.groupLabel") : t("common:access.userLabel"))}
          </span>
        </div>
        <RoleSelect
          value={member.role}
          options={roles}
          label={t("common:access.roleFor", { name: member.name })}
          disabled={busy || member.missing}
          onChange={(next) => { if (next !== member.role) onGrant(member.subjectType, member.subjectId, next); }}
        />
        <Button
          variant="icon"
          danger
          onClick={() => onRevoke(member.subjectType, member.subjectId)}
          disabled={busy}
          title={t("common:access.remove", { name: member.name })}
          aria-label={t("common:access.remove", { name: member.name })}
        >
          <Trash2 size={15} />
        </Button>
      </div>
    );
  };

  return (
    <div className="access-control">
      {candidates && (
        <section className="member-section">
          <h3 className="member-section-title">{t("common:access.grantTitle")}</h3>
          <div className="member-grant">
            <div className="member-field member-field-grow">
              <Users size={17} className="member-field-icon" aria-hidden="true" />
              <select
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                disabled={busy}
                aria-label={t("common:access.pickSubject")}
              >
                <option value="">{t("common:access.pickSubject")}</option>
                {/* An empty optgroup still draws its label in some browsers,
                    so a group with nobody left to add is dropped entirely. */}
                {freeUsers.length > 0 && (
                  <optgroup label={t("common:access.usersGroup")}>
                    {freeUsers.map((candidate) => (
                      <option key={candidate.id} value={`user:${candidate.id}`}>{candidate.name}</option>
                    ))}
                  </optgroup>
                )}
                {freeGroups.length > 0 && (
                  <optgroup label={t("common:access.groupsGroup")}>
                    {freeGroups.map((candidate) => (
                      <option key={candidate.id} value={`group:${candidate.id}`}>{candidate.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            {/* No member-field wrapper: the role control carries its own dot,
                and a second leading icon would collide with it. */}
            <RoleSelect
              value={newRole}
              options={roles}
              label={t("common:access.roleToGrant")}
              disabled={busy}
              onChange={setNewRole}
            />
            <Button variant="primary" onClick={add} disabled={busy || !subject}>
              <UserPlus size={16} aria-hidden="true" />
              <span>{t("common:access.add")}</span>
            </Button>
          </div>
        </section>
      )}

      <div className="member-rows">
        {/* Everyone is a group like any other — same row, same controls. It
            simply always exists, so its cell where the others carry a bin is
            left empty: there is nothing to delete, only a role to change. */}
        {everyone && (
          <div className="member-row member-row-everyone">
            <span className="member-avatar member-avatar-neutral" aria-hidden="true"><Globe2 size={18} /></span>
            <div className="member-identity">
              <span className="member-name">
                {t("common:access.everyone")}
                {everyone.role && <span className="member-baseline-tag">{t("common:access.public")}</span>}
              </span>
              <span className="member-sub">{everyone.hint}</span>
            </div>
            {everyone.options ? (
              <RoleSelect
                value={everyone.role ?? ACCESS_NONE}
                options={everyone.options}
                label={t("common:access.everyone")}
                disabled={busy}
                onChange={(role) => everyone.onChange?.(role === ACCESS_NONE ? null : role)}
              />
            ) : everyone.role ? (
              <RoleSelect value={everyone.role} options={roles} label={t("common:access.everyone")} disabled />
            ) : (
              <span className="member-noaccess">{t("common:access.noAccess")}</span>
            )}
            <span className="member-row-noaction" title={everyone.lockedHint} />
          </div>
        )}

        {listed.map(row)}

        {members.length === 0 && (
          <p className="member-empty">{emptyHint ?? t("common:access.nobodyYet")}</p>
        )}
      </div>

      {/* What each word means, in the order the roles escalate. The same
          objects the dropdowns render, so the two can never drift apart. */}
      {showLegend && (
        <MessageBox tone="info" className="access-role-legend-box" title={t("common:access.legendTitle")}>
          <dl className="member-role-legend">
            {roles.map((role) => (
              <div key={role.value}>
                <dt style={{ color: role.dot }}>{role.label}</dt>
                <dd>{role.tagline}</dd>
              </div>
            ))}
          </dl>
        </MessageBox>
      )}
    </div>
  );
}
