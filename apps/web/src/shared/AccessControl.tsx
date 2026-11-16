import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe2, Search, Users, X } from "lucide-react";
import { Button } from "./Button";
import { SelectMenu } from "./SelectMenu";
import { avatarHue, avatarInitials } from "./utils";

/** One word in a surface's access vocabulary. */
export interface AccessRole {
  value: string;
  label: string;
  /** One line saying what the role may do — shown under "Roles". */
  tagline: string;
  /** The dot beside the role in its menu. */
  dot: string;
}

/** Somebody (or some group) already on the list. */
export interface AccessGrant {
  subjectType: "user" | "group";
  subjectId: string;
  name: string;
  /** Second line: an email, a member count, whatever the caller knows. */
  sub?: string;
  /** Unused in on/off mode (no roles). */
  role: string;
  /** The user or group is gone — its role is frozen, removing it still works. */
  missing?: boolean;
}

/** Somebody who has access only through a group: shown, not changed, here. */
export interface AccessInherited {
  subjectId: string;
  name: string;
  /** The group it comes through. */
  via: string;
}

export interface AccessCandidate {
  id: string;
  name: string;
  /** A short word beside the name in the Add list ("admin", "3 members"). */
  sub?: string;
}

/** The household baseline. Omit the whole prop for surfaces that have none. */
export interface AccessEveryone {
  /** null = no access. */
  role: string | null;
  /** What the baseline means here — the row's tooltip. */
  hint: string;
  /** Given = the baseline is editable, from this vocabulary. */
  options?: AccessRole[];
  onChange?: (role: string | null) => void;
  /** Why the row is fixed here (set elsewhere). */
  lockedHint?: string;
  /** Tag the row Public while it has a role. Off where the list is not about visibility. */
  publicTag?: boolean;
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

// The role menu with its colour dot.
function RoleSelect({ value, options, label, disabled, onChange }: {
  value: string;
  options: AccessRole[];
  label: string;
  disabled?: boolean;
  onChange?: (role: string) => void;
}) {
  // The shared SelectMenu (an app control, not the browser's select), each role
  // with its colour dot.
  return (
    <SelectMenu
      className="ax-role"
      value={value}
      label={label}
      disabled={disabled || !onChange}
      onChange={(next) => onChange?.(next)}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        icon: <span className="ax-dot" style={{ background: option.dot }} />
      }))}
    />
  );
}

function Avatar({ kind, name }: { kind: "user" | "group" | "everyone"; name: string }) {
  if (kind === "everyone") return <span className="ax-avatar is-neutral" aria-hidden="true"><Globe2 size={13} /></span>;
  if (kind === "group") return <span className="ax-avatar is-neutral is-square" aria-hidden="true"><Users size={13} /></span>;
  return <span className="ax-avatar" style={{ background: `hsl(${avatarHue(name)}, 58%, 52%)` }} aria-hidden="true">{avatarInitials(name)}</span>;
}

// Who can see a thing, and what they may do with it — the one access window the
// whole app shares (owner, 2026-11-16): a compact popup with two tabs. Access
// lists who has it — Everyone, then groups, then people, each a one-line row with
// a role menu and × — and Add finds people or groups by search, ticks several, and
// gives them one role. Libraries, story collections, family branches, the Inbox
// and personal libraries all use it; only the ROLE VOCABULARY (none at all for an
// on/off list) and the data change, and both arrive as props.
//
// The caller owns the requests: this renders what it is given and calls back. It
// never talks to the server, because each surface has its own endpoints.
export function AccessControl({
  roles,
  members,
  candidates,
  everyone,
  inherited = [],
  busy = false,
  defaultRole,
  onGrant,
  onRevoke,
  showLegend = true,
  emptyHint
}: {
  /** The vocabulary for grants, in the order it escalates. Empty = on/off: a row
   *  means "has access", and grants carry the first role the caller gives back. */
  roles: AccessRole[];
  members: AccessGrant[];
  /** Omit to hide the Add tab (a read-only view of who has access). */
  candidates?: { users: AccessCandidate[]; groups: AccessCandidate[] };
  everyone?: AccessEveryone;
  /** People with access only through a group — shown read-only, "via …". */
  inherited?: AccessInherited[];
  busy?: boolean;
  /** Which role Add starts on. Defaults to the first listed. */
  defaultRole?: string;
  onGrant: (subjectType: "user" | "group", subjectId: string, role: string) => void;
  onRevoke: (subjectType: "user" | "group", subjectId: string) => void;
  /** Offer "Roles" — what each role may do. */
  showLegend?: boolean;
  /** Shown when nobody has been granted anything. */
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common"]);
  const [tab, setTab] = useState<"access" | "add">("access");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [newRole, setNewRole] = useState(defaultRole ?? roles[0]?.value ?? "");
  const [legendOpen, setLegendOpen] = useState(false);
  const toggle = roles.length === 0;

  const granted = useMemo(() => new Set(members.map((member) => `${member.subjectType}:${member.subjectId}`)), [members]);
  // Ordered by reach: the baseline, then groups, then individuals — the widest
  // grant is read before the narrow ones it sits under.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const listed = [
    ...members.filter((member) => member.subjectType === "group").sort(byName),
    ...members.filter((member) => member.subjectType === "user").sort(byName)
  ];
  const viaRows = inherited.filter((entry) => !granted.has(`user:${entry.subjectId}`)).sort(byName);

  const needle = query.trim().toLowerCase();
  const matches = (candidate: AccessCandidate) => !needle || candidate.name.toLowerCase().includes(needle);
  const freeGroups = (candidates?.groups ?? []).filter((c) => !granted.has(`group:${c.id}`) && matches(c)).sort(byName);
  const freeUsers = (candidates?.users ?? []).filter((c) => !granted.has(`user:${c.id}`) && matches(c)).sort(byName);

  const pick = (key: string) => setPicked((before) => {
    const next = new Set(before);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const add = () => {
    for (const key of picked) {
      const [subjectType, subjectId] = key.split(":");
      if ((subjectType === "user" || subjectType === "group") && subjectId) onGrant(subjectType, subjectId, newRole);
    }
    setPicked(new Set());
    setQuery("");
    setTab("access");
  };

  const accessTab = (
    <div className="ax-list" role="tabpanel" aria-label={t("common:access.tabAccess")}>
      {/* Everyone is a row like any other, without ×: it always exists. */}
      {everyone && (
        <div className="ax-row" title={everyone.lockedHint ?? everyone.hint}>
          <Avatar kind="everyone" name="" />
          <span className="ax-name">
            {t("common:access.everyone")}
            {everyone.role && everyone.publicTag !== false && <small className="ax-tag">{t("common:access.public")}</small>}
          </span>
          {toggle && !everyone.options ? (
            <span className="ax-has">{everyone.role ? t("common:access.hasAccess") : t("common:access.noAccess")}</span>
          ) : everyone.options ? (
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
            <span className="ax-has">{t("common:access.noAccess")}</span>
          )}
          <span className="ax-x-spacer" aria-hidden="true" />
        </div>
      )}

      {listed.map((member) => (
        <div className="ax-row" key={`${member.subjectType}:${member.subjectId}`}>
          <Avatar kind={member.subjectType} name={member.name} />
          <span className="ax-name" title={member.sub}>
            {member.name}
            {member.missing ? <small>{t("common:access.deleted")}</small> : member.sub && <small>{member.sub}</small>}
          </span>
          {toggle ? (
            <span className="ax-has">{t("common:access.hasAccess")}</span>
          ) : (
            <RoleSelect
              value={member.role}
              options={roles}
              label={t("common:access.roleFor", { name: member.name })}
              disabled={busy || member.missing}
              onChange={(next) => { if (next !== member.role) onGrant(member.subjectType, member.subjectId, next); }}
            />
          )}
          <Button
            variant="icon"
            className="ax-x"
            onClick={() => onRevoke(member.subjectType, member.subjectId)}
            disabled={busy}
            title={t("common:access.remove", { name: member.name })}
            aria-label={t("common:access.remove", { name: member.name })}
          >
            <X size={14} />
          </Button>
        </div>
      ))}

      {viaRows.map((entry) => (
        <div className="ax-row is-inherited" key={`via:${entry.subjectId}`}>
          <Avatar kind="user" name={entry.name} />
          <span className="ax-name">{entry.name}</span>
          <span className="ax-has">{t("common:access.via", { group: entry.via })}</span>
          <span className="ax-x-spacer" aria-hidden="true" />
        </div>
      ))}

      {/* An empty hint of "" says nothing at all (the baseline already says it). */}
      {members.length === 0 && emptyHint !== "" && <p className="ax-empty">{emptyHint ?? t("common:access.nobodyYet")}</p>}
    </div>
  );

  const addTab = (
    <div className="ax-add" role="tabpanel" aria-label={t("common:access.tabAdd")}>
      <label className="ax-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t("common:access.search")}
          aria-label={t("common:access.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="ax-list">
        {[...freeGroups.map((c) => ({ kind: "group" as const, c })), ...freeUsers.map((c) => ({ kind: "user" as const, c }))].map(({ kind, c }) => {
          const key = `${kind}:${c.id}`;
          return (
            <label className="ax-row is-pick" key={key}>
              <input type="checkbox" checked={picked.has(key)} onChange={() => pick(key)} disabled={busy} />
              <Avatar kind={kind} name={c.name} />
              <span className="ax-name">
                {c.name}
                {(c.sub || kind === "group") && <small>{c.sub ?? t("common:access.groupLabel")}</small>}
              </span>
            </label>
          );
        })}
        {freeGroups.length === 0 && freeUsers.length === 0 && (
          <p className="ax-empty">{needle ? t("common:access.noMatch") : t("common:access.everyoneAdded")}</p>
        )}
      </div>
    </div>
  );

  return (
    <div className="access-control">
      {candidates && (
        <div className="ax-tabs modal-tabs" role="tablist">
          <Button variant="tab" className="modal-tab" selected={tab === "access"} onClick={() => setTab("access")}>
            {t("common:access.tabAccess")}
          </Button>
          <Button variant="tab" className="modal-tab" selected={tab === "add"} onClick={() => setTab("add")}>{t("common:access.tabAdd")}</Button>
        </div>
      )}

      {tab === "add" && candidates ? addTab : accessTab}

      <div className="ax-foot">
        {tab === "add" && candidates ? (
          <>
            {!toggle
              ? <RoleSelect value={newRole} options={roles} label={t("common:access.roleToGrant")} disabled={busy} onChange={setNewRole} />
              : <span />}
            <Button variant="primary" compact onClick={add} disabled={busy || picked.size === 0}>
              {picked.size ? t("common:access.addCount", { count: picked.size }) : t("common:access.add")}
            </Button>
          </>
        ) : (
          <>
            {showLegend && !toggle ? (
              <Button variant="text" compact aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => !open)}>
                {t("common:access.roles")}
              </Button>
            ) : <span />}
            <small>{t("common:access.savedAsYouGo")}</small>
          </>
        )}
      </div>

      {/* What each role may do, in the order they escalate — the same objects the
          menus render, so the two can never drift apart. */}
      {legendOpen && tab === "access" && (
        <dl className="ax-legend">
          {roles.map((role) => (
            <div key={role.value}>
              <dt><span className="ax-dot" style={{ background: role.dot }} aria-hidden="true" /> {role.label}</dt>
              <dd>{role.tagline}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
