import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Ban, Check, Globe2, Info, Layers, List, Search, User, Users } from "lucide-react";
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
  /** A person by default; a group can have it another way too (a family branch). */
  subjectType?: "user" | "group";
  name: string;
  /** The group it comes through ("via Kids"). */
  via?: string;
  /** Said instead, when it is not a group ("Through the Posse branch", "Their own account"). */
  note?: string;
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

/** On/off access: the app's switch (the one settings rows wear), saved when moved. */
function AccessSwitch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <Button variant="bare" className="ax-switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <span className={`grouped-switch${on ? " is-on" : ""}`} aria-hidden="true"><i /></span>
    </Button>
  );
}

function Avatar({ kind, name }: { kind: "user" | "group" | "everyone"; name: string }) {
  if (kind === "everyone") return <span className="ax-avatar is-neutral" aria-hidden="true"><Globe2 size={13} /></span>;
  if (kind === "group") return <span className="ax-avatar is-neutral is-square" aria-hidden="true"><Users size={13} /></span>;
  return <span className="ax-avatar" style={{ background: `hsl(${avatarHue(name)}, 58%, 52%)` }} aria-hidden="true">{avatarInitials(name)}</span>;
}

/** One row of the Access list: a person or group, and what they have (null = no access). */
interface Row {
  key: string;
  kind: "user" | "group";
  id: string;
  name: string;
  sub?: string;
  role: string | null;
  missing: boolean;
  /** The group a person has access through, when not directly. */
  via?: string;
}

/** The tick-box key for the Everyone row. */
const EVERYONE = "everyone";
/** An on/off list's one level, as a menu value. */
const HAS = "__has";

// Who can see a thing, and what they may do with it — the one access window the
// whole app shares (owner, 2026-11-16). One list of EVERYONE who could have it —
// Everyone, then groups, then people — under a search and a filter (All / Has
// access / No access), scrolling on its own. Where there are roles, each row has a
// role menu (with "No access") and a tick box: tick several and "Apply to selected"
// sets them all at once. Where there are none (on/off), each row has a switch — the
// app's own, as in every settings list — and the header's switch gives or takes it
// for everyone shown. Libraries, story collections, family branches, the Inbox and
// personal libraries all use it; only the ROLE VOCABULARY (none at all for an
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
  onGrantMany,
  onRevoke,
  onRevokeMany,
  showLegend = true,
  emptyHint
}: {
  /** The vocabulary for grants, in the order it escalates. Empty = on/off: a row
   *  either has access or not. */
  roles: AccessRole[];
  members: AccessGrant[];
  /** Everyone who could be given access. Omit for a read-only list of who has it. */
  candidates?: { users: AccessCandidate[]; groups: AccessCandidate[] };
  everyone?: AccessEveryone;
  /** People with access only through a group — said beside their row ("via …"). */
  inherited?: AccessInherited[];
  busy?: boolean;
  /** Which role Add and "Apply to selected" start on. Defaults to the first listed. */
  defaultRole?: string;
  /** One grant. Return its promise: several at once wait for each in turn. */
  onGrant: (subjectType: "user" | "group", subjectId: string, role: string) => void | Promise<unknown>;
  /** Several grants in one save — for a place that saves its whole list (personal
   *  libraries), where one at a time would each overwrite the last. */
  onGrantMany?: (subjects: { subjectType: "user" | "group"; subjectId: string }[], role: string) => void | Promise<unknown>;
  onRevoke: (subjectType: "user" | "group", subjectId: string) => void | Promise<unknown>;
  /** Several removals in one save (see onGrantMany). */
  onRevokeMany?: (subjects: { subjectType: "user" | "group"; subjectId: string }[]) => void | Promise<unknown>;
  /** Offer "Roles" — what each role may do. */
  showLegend?: boolean;
  /** Shown when nobody is on the list at all. */
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common"]);
  const [legendOpen, setLegendOpen] = useState(false);
  const toggle = roles.length === 0;
  const startRole = defaultRole ?? roles[0]?.value ?? HAS;

  // ── The vocabulary every menu here offers: No access, then the roles (or "Has
  // access" in an on/off list).
  const noAccess: AccessRole = { value: ACCESS_NONE, label: t("common:access.noAccess"), tagline: "", dot: ACCESS_ROLE_DOT.none };
  const hasAccess: AccessRole = { value: HAS, label: t("common:access.hasAccess"), tagline: "", dot: ACCESS_ROLE_DOT.contributor };
  const rowOptions = [noAccess, ...(toggle ? [hasAccess] : roles)];

  // ── Everybody, with what they have: candidates first, grants laid over them.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    // How someone has it another way: "via a group", or the caller's own words.
    const via = new Map(inherited.map((entry) => [`${entry.subjectType ?? "user"}:${entry.subjectId}`, entry.note ?? t("common:access.via", { group: entry.via ?? "" })]));
    for (const kind of ["group", "user"] as const) {
      for (const c of (kind === "group" ? candidates?.groups : candidates?.users) ?? []) {
        map.set(`${kind}:${c.id}`, { key: `${kind}:${c.id}`, kind, id: c.id, name: c.name, sub: c.sub, role: null, missing: false, via: via.get(`${kind}:${c.id}`) });
      }
    }
    for (const member of members) {
      const key = `${member.subjectType}:${member.subjectId}`;
      const before = map.get(key);
      map.set(key, {
        key, kind: member.subjectType, id: member.subjectId, name: member.name,
        sub: member.sub ?? before?.sub, role: toggle ? HAS : member.role, missing: Boolean(member.missing), via: undefined
      });
    }
    const all = [...map.values()];
    return [...all.filter((row) => row.kind === "group").sort(byName), ...all.filter((row) => row.kind === "user").sort(byName)];
  }, [candidates, members, inherited, toggle, t]);

  const everyoneEditable = Boolean(everyone?.onChange && everyone.options);
  const everyoneValue = everyone?.role ? (toggle ? HAS : everyone.role) : ACCESS_NONE;

  // ── Search, view (groups, people or both) and filter (with or without access).
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"both" | "groups" | "users">("both");
  const [filter, setFilter] = useState<"all" | "with" | "without">("all");
  const needle = query.trim().toLowerCase();
  const has = (row: Row) => row.role !== null;
  // Everyone is the widest group: it shows with groups, not with people.
  const everyoneInView = Boolean(everyone) && view !== "users";
  const inView = rows.filter((row) => view === "both" || (view === "groups") === (row.kind === "group"));
  const everyoneShown = everyoneInView && (!needle || t("common:access.everyone").toLowerCase().includes(needle))
    && (filter === "all" || (filter === "with") === Boolean(everyone?.role));
  const shown = inView.filter((row) => (!needle || row.name.toLowerCase().includes(needle))
    && (filter === "all" || (filter === "with") === has(row)));
  // The filter's counts are of what the view shows.
  const total = inView.length + (everyoneInView ? 1 : 0);
  const withCount = inView.filter(has).length + (everyoneInView && everyone?.role ? 1 : 0);

  // ── Ticks, and setting the ticked all at once.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkRole, setBulkRole] = useState(startRole);
  const selectable = [...(everyoneShown && everyoneEditable ? [EVERYONE] : []), ...shown.filter((row) => !row.missing).map((row) => row.key)];
  const allTicked = selectable.length > 0 && selectable.every((key) => selected.has(key));
  const tick = (key: string) => setSelected((before) => {
    const next = new Set(before);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const tickAll = () => setSelected(allTicked ? new Set() : new Set(selectable));

  // On/off: the tick box is the access. The header's box is ticked when everyone
  // shown has it, and gives it to (or takes it from) all of them.
  const shownRows = shown.filter((row) => !row.missing);
  const allHave = shownRows.length > 0 && shownRows.every(has) && (!everyoneShown || !everyoneEditable || Boolean(everyone?.role));
  const toggleAll = async () => {
    const subjects = (list: Row[]) => list.map((row) => ({ subjectType: row.kind, subjectId: row.id }));
    if (allHave) {
      const holding = shownRows.filter(has);
      if (onRevokeMany && holding.length) await onRevokeMany(subjects(holding));
      else for (const row of holding) await onRevoke(row.kind, row.id);
    } else {
      const missing = shownRows.filter((row) => !has(row));
      if (onGrantMany && missing.length) await onGrantMany(subjects(missing), "");
      else for (const row of missing) await onGrant(row.kind, row.id, "");
    }
  };

  /** One subject to a value from the menu: No access removes, anything else grants. */
  const setOne = (row: Row, value: string) => {
    if (value === (row.role ?? ACCESS_NONE)) return;
    if (value === ACCESS_NONE) return onRevoke(row.kind, row.id);
    return onGrant(row.kind, row.id, value === HAS ? "" : value);
  };
  const setEveryone = (value: string) => {
    if (!everyone?.onChange) return;
    if (value === ACCESS_NONE) return everyone.onChange(null);
    // An on/off list's "Has access" is whatever the caller calls having it.
    const own = toggle ? everyone.options?.find((option) => option.value !== ACCESS_NONE)?.value : value;
    if (own && everyone.options?.some((option) => option.value === own)) everyone.onChange(own);
  };

  // Everyone ticked gets the chosen value — in one save where the place takes a
  // list, else one at a time, each waiting for the last so none is lost.
  const applySelected = async () => {
    const chosen = rows.filter((row) => selected.has(row.key) && !row.missing);
    if (selected.has(EVERYONE)) await setEveryone(bulkRole);
    const subjects = (list: Row[]) => list.map((row) => ({ subjectType: row.kind, subjectId: row.id }));
    if (bulkRole === ACCESS_NONE) {
      const holding = chosen.filter(has);
      if (onRevokeMany && holding.length) await onRevokeMany(subjects(holding));
      else for (const row of holding) await onRevoke(row.kind, row.id);
    } else {
      const changing = chosen.filter((row) => row.role !== bulkRole);
      const role = bulkRole === HAS ? "" : bulkRole;
      if (onGrantMany && changing.length) await onGrantMany(subjects(changing), role);
      else for (const row of changing) await onGrant(row.kind, row.id, role);
    }
    setSelected(new Set());
  };

  const filterOptions = [
    { value: "all" as const, label: t("common:access.filterAll", { count: total }), icon: <List size={15} /> },
    { value: "with" as const, label: t("common:access.filterWith", { count: withCount }), icon: <Check size={15} /> },
    { value: "without" as const, label: t("common:access.filterWithout", { count: total - withCount }), icon: <Ban size={15} /> }
  ];
  const viewOptions = [
    { value: "both" as const, label: t("common:access.viewBoth"), icon: <Layers size={15} /> },
    { value: "groups" as const, label: t("common:access.viewGroups"), icon: <Users size={15} /> },
    { value: "users" as const, label: t("common:access.viewUsers"), icon: <User size={15} /> }
  ];

  const accessTab = (
    <div className="ax-pane">
      <div className="ax-toolbar">
        <label className="ax-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} placeholder={t("common:access.search")} aria-label={t("common:access.search")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <SelectMenu className="ax-filter" value={view} label={t("common:access.viewLabel")} options={viewOptions} onChange={setView} />
        <SelectMenu className="ax-filter" value={filter} label={t("common:access.filterLabel")} options={filterOptions} onChange={setFilter} />
      </div>

      <div className="ax-table">
        <div className={`ax-head${toggle ? " is-toggle" : ""}`}>
          {!toggle && <input type="checkbox" checked={allTicked} onChange={tickAll} disabled={busy || selectable.length === 0} aria-label={t("common:access.selectAll")} />}
          <span>{t("common:access.peopleAndGroups")}</span>
          {toggle
            ? <AccessSwitch on={allHave} label={t("common:access.giveAllShown")} disabled={busy || shownRows.length === 0} onChange={() => void toggleAll()} />
            : <span>{t("common:access.columnAccess")}</span>}
        </div>
        <div className="ax-list">
          {everyone && everyoneShown && (
            <div className={`ax-row${selected.has(EVERYONE) ? " is-selected" : ""}`} title={everyone.lockedHint ?? everyone.hint}>
              {!toggle && (everyoneEditable
                ? <input type="checkbox" checked={selected.has(EVERYONE)} onChange={() => tick(EVERYONE)} disabled={busy} aria-label={t("common:access.selectOne", { name: t("common:access.everyone") })} />
                : <span className="ax-check-spacer" aria-hidden="true" />)}
              <Avatar kind="everyone" name="" />
              <span className="ax-name">
                {t("common:access.everyone")}
                {everyone.role && everyone.publicTag !== false && <small className="ax-tag">{t("common:access.public")}</small>}
              </span>
              {toggle && (
                <AccessSwitch
                  on={Boolean(everyone.role)}
                  label={t("common:access.accessFor", { name: t("common:access.everyone") })}
                  disabled={busy || !everyoneEditable}
                  onChange={(on) => void setEveryone(on ? HAS : ACCESS_NONE)}
                />
              )}
              {!toggle && (
                <RoleSelect
                  value={everyoneValue}
                  options={everyone.options ?? rowOptions}
                  label={t("common:access.everyone")}
                  disabled={busy || !everyoneEditable}
                  onChange={everyoneEditable ? (value) => void setEveryone(value) : undefined}
                />
              )}
            </div>
          )}

          {shown.map((row) => (
            <div className={`ax-row${!toggle && selected.has(row.key) ? " is-selected" : ""}`} key={row.key}>
              {!toggle && <input type="checkbox" checked={selected.has(row.key)} onChange={() => tick(row.key)} disabled={busy || row.missing} aria-label={t("common:access.selectOne", { name: row.name })} />}
              <Avatar kind={row.kind} name={row.name} />
              <span className="ax-name" title={row.sub}>
                {row.name}
                {row.kind === "group" && <small className="ax-kind">{t("common:access.groupLabel")}</small>}
                {row.missing ? <small>{t("common:access.deleted")}</small> : row.via && !has(row) ? <small>{row.via}</small> : null}
              </span>
              {toggle && (
                <AccessSwitch
                  on={has(row)}
                  label={t("common:access.accessFor", { name: row.name })}
                  disabled={busy || row.missing}
                  onChange={(on) => void setOne(row, on ? HAS : ACCESS_NONE)}
                />
              )}
              {!toggle && (
                <RoleSelect
                  value={row.role ?? ACCESS_NONE}
                  options={rowOptions}
                  label={t("common:access.roleFor", { name: row.name })}
                  disabled={busy || row.missing}
                  onChange={(value) => void setOne(row, value)}
                />
              )}
            </div>
          ))}

          {!everyoneShown && shown.length === 0 && (
            <p className="ax-empty">
              {needle || filter !== "all" ? t("common:access.noMatch") : emptyHint !== "" ? emptyHint ?? t("common:access.nobodyYet") : null}
            </p>
          )}
        </div>
      </div>

      {!toggle && selected.size > 0 ? (
        <div className="ax-bulk">
          <strong>{t("common:access.selectedCount", { count: selected.size })}</strong>
          <RoleSelect value={bulkRole} options={rowOptions} label={t("common:access.roleToGrant")} disabled={busy} onChange={setBulkRole} />
          <Button variant="primary" compact onClick={() => void applySelected()} disabled={busy}>
            <Check size={15} aria-hidden="true" /> {t("common:access.applySelected")}
          </Button>
        </div>
      ) : (
        <div className="ax-foot">
          {showLegend && !toggle ? (
            <Button variant="text" compact aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => !open)}>
              {t("common:access.roles")}
            </Button>
          ) : <span />}
          <small><Info size={13} aria-hidden="true" /> {t("common:access.savedAutomatically")}</small>
        </div>
      )}

      {/* What each role may do, in the order they escalate — the same objects the
          menus render, so the two can never drift apart. */}
      {legendOpen && selected.size === 0 && (
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

  return <div className="access-control">{accessTab}</div>;
}
