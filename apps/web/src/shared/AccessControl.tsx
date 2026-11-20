import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Globe2, Info, Lock, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { Button } from "./Button";
import { useMenuKeyboard } from "./useMenuKeyboard";
import { avatarHue, avatarInitials } from "./utils";

/** One word in a surface's access vocabulary. */
export interface AccessRole {
  value: string;
  label: string;
  /** One line saying what the role may do — beside it in the menu, and under the list ("Roles"). */
  tagline: string;
  /** The dot beside the role in its menu. */
  dot: string;
}

/** Somebody (or some group) already on the list. */
export interface AccessGrant {
  subjectType: "user" | "group";
  subjectId: string;
  name: string;
  /** What else the caller knows — an email, a member count. The row's tooltip. */
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
  /** What the baseline means here — the Everyone row's tooltip, and the card's line without a summary. */
  hint: string;
  /** Given = the baseline is editable, from this vocabulary. */
  options?: AccessRole[];
  onChange?: (role: string | null) => void;
  /** Why the row is fixed here (set elsewhere). */
  lockedHint?: string;
  /** Tag the row Public while it has a role, and say so in the card at the top.
   *  Off where the list is not about visibility. */
  publicTag?: boolean;
  /** The card's line: what being public (or private) means here ("Everyone can
   *  view and download from this library."). The hint when omitted. */
  summary?: string;
  /** The card's heading in the place's own words ("This library is public."). */
  cardTitle?: string;
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

/** The value of the role that blocks, whatever else would let someone in. */
export const ACCESS_DENY = "deny";

// The roles that take access away are not a rung on the ladder: the menu sets
// them apart under a rule, and "Roles" under the list (an escalation) leaves them out.
function standsApart(role: AccessRole): boolean {
  return role.value === ACCESS_DENY || role.value === ACCESS_NONE;
}

// The role menu: each role with its dot and, beside it, what it allows — so the
// choice is made with the meaning in view. Under a rule, the roles that take
// access away; under another, Remove access. A menu rather than SelectMenu's
// listbox because it ends in an action.
//
// `value: null` is the form for several ticked rows: no role is current, and the
// trigger reads `placeholder`.
function RoleMenu({ value, options, label, placeholder, disabled, onChange, onRemove }: {
  value: string | null;
  options: AccessRole[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Omit for a role that is shown but cannot be changed (its subject is gone). */
  onChange?: (role: string) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation(["common"]);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number; minWidth: number } | null>(null);
  const selected = options.find((option) => option.value === value);

  // Portalled to <body> and placed by hand, as ActionMenu is: the list scrolls,
  // and would clip a menu hanging off its last rows.
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const height = popoverRef.current?.offsetHeight ?? 0;
    const below = window.innerHeight - rect.bottom;
    const flip = height > 0 && below < height + 16 && rect.top > below;
    setAnchor({
      top: flip ? rect.top - height - 6 : rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
      minWidth: rect.width
    });
  }, []);

  const menuKeys = useMenuKeyboard({
    open: open && anchor !== null,
    close: () => setOpen(false),
    menuRef: popoverRef,
    triggerRef
  });

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    // The menu belongs to one row of a list that scrolls. Following the row would
    // leave it hanging in the air once the row is scrolled out of sight, so a
    // scroll anywhere but inside the menu itself closes it.
    const onScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => place();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, place]);

  const item = (role: AccessRole) => {
    const active = role.value === value;
    return (
      <Button
        key={role.value}
        variant="bare"
        className={`ax-role-option${active ? " active" : ""}`}
        role="menuitemradio"
        aria-checked={active}
        disabled={!onChange}
        onClick={() => {
          menuKeys.closeAndRestore();
          if (!active) onChange?.(role.value);
        }}
      >
        <span className="ax-dot" style={{ background: role.dot }} aria-hidden="true" />
        <span className="ax-role-option-name">{role.label}</span>
        <span className="ax-role-option-tagline">{role.tagline}</span>
        <span className="ax-role-option-check" aria-hidden="true">{active && <Check size={16} />}</span>
      </Button>
    );
  };

  const ladder = options.filter((role) => !standsApart(role));
  const apart = options.filter(standsApart);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        className={`ax-role${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={selected ? `${label}: ${selected.label}` : label}
        onClick={() => setOpen((current) => !current)}
      >
        {selected && <span className="ax-dot" style={{ background: selected.dot }} aria-hidden="true" />}
        <span className="ax-role-label">{selected?.label ?? placeholder ?? label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>

      {open && createPortal(
        <div
          ref={popoverRef}
          id={menuId}
          className="select-menu-popover action-menu-popover ax-role-menu"
          role="menu"
          aria-label={label}
          onKeyDown={menuKeys.onKeyDown}
          // Hidden until measured, or the first paint lands at the page corner.
          style={anchor ? { top: anchor.top, right: anchor.right, minWidth: anchor.minWidth } : { visibility: "hidden" }}
        >
          {ladder.map(item)}
          {apart.length > 0 && ladder.length > 0 && <div className="ax-role-rule" role="separator" />}
          {apart.map(item)}
          {onRemove && (
            <>
              <div className="ax-role-rule" role="separator" />
              <Button
                variant="bare"
                className="ax-role-option ax-role-remove"
                role="menuitem"
                onClick={() => {
                  menuKeys.closeAndRestore();
                  onRemove();
                }}
              >
                <Trash2 size={15} aria-hidden="true" />
                <span className="ax-role-option-name">{t("common:access.removeAccess")}</span>
              </Button>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

function Avatar({ kind, name }: { kind: "user" | "group" | "everyone"; name: string }) {
  if (kind === "everyone") return <span className="ax-avatar is-neutral" aria-hidden="true"><Globe2 size={17} /></span>;
  if (kind === "group") return <span className="ax-avatar is-neutral" aria-hidden="true"><Users size={17} /></span>;
  return <span className="ax-avatar" style={{ background: `hsl(${avatarHue(name)}, 58%, 52%)` }} aria-hidden="true">{avatarInitials(name)}</span>;
}

/** One row of the list: a person or group, and what they have (null = through a group only). */
interface Row {
  key: string;
  kind: "user" | "group";
  id: string;
  name: string;
  sub?: string;
  role: string | null;
  missing: boolean;
  /** How they have it when not directly ("via Kids"). */
  via?: string;
}

/** An on/off list's one level. */
const HAS = "__has";

// Who can see a thing, and what they may do with it — the one access editor the
// whole app shares (owner, 2026-11-19 redesign): a card saying whether it is open to
// everyone, ONE "Add people or groups" field with the role to give and Add, then the
// table of those who have it — Everyone, groups, people — each with a role menu that
// says what every role allows and ends in Remove access; tick several rows and the
// Access heading becomes the menu for all of them. Under it, the roles spelled out.
// Where there are no roles (on/off), Add gives access and each row has Remove. Libraries,
// story collections, family branches, the Inbox, apps and personal libraries all
// use it; only the ROLE VOCABULARY and the data change, and both arrive as props.
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
  /** People with access only through a group — listed with how ("via …"). */
  inherited?: AccessInherited[];
  busy?: boolean;
  /** Which role Add starts on. Defaults to the first listed. */
  defaultRole?: string;
  /** One grant. Return its promise. */
  onGrant: (subjectType: "user" | "group", subjectId: string, role: string) => void | Promise<unknown>;
  /** A place that saves its whole list (personal libraries) gives each change as a list. */
  onGrantMany?: (subjects: { subjectType: "user" | "group"; subjectId: string }[], role: string) => void | Promise<unknown>;
  onRevoke: (subjectType: "user" | "group", subjectId: string) => void | Promise<unknown>;
  /** See onGrantMany. */
  onRevokeMany?: (subjects: { subjectType: "user" | "group"; subjectId: string }[]) => void | Promise<unknown>;
  /** Spell out what each role may do, under the list. */
  showLegend?: boolean;
  /** Shown when nobody is on the list at all. */
  emptyHint?: string;
}) {
  const { t } = useTranslation(["common"]);
  const toggle = roles.length === 0;
  const startRole = defaultRole ?? roles[0]?.value ?? HAS;

  // ── A fixed baseline is shown from the roles, plus No access for a private thing.
  const noAccess: AccessRole = { value: ACCESS_NONE, label: t("common:access.noAccess"), tagline: "", dot: ACCESS_ROLE_DOT.none };

  // ── Who has it: grants, then those who have it through a group.
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    const sub = new Map<string, string | undefined>();
    for (const kind of ["group", "user"] as const) {
      for (const c of (kind === "group" ? candidates?.groups : candidates?.users) ?? []) sub.set(`${kind}:${c.id}`, c.sub);
    }
    for (const member of members) {
      const key = `${member.subjectType}:${member.subjectId}`;
      map.set(key, {
        key, kind: member.subjectType, id: member.subjectId, name: member.name,
        sub: member.sub ?? sub.get(key), role: toggle ? HAS : member.role, missing: Boolean(member.missing)
      });
    }
    for (const entry of inherited) {
      const kind = entry.subjectType ?? "user";
      const key = `${kind}:${entry.subjectId}`;
      if (map.has(key)) continue;
      map.set(key, { key, kind, id: entry.subjectId, name: entry.name, sub: sub.get(key), role: null, missing: false,
        via: entry.note ?? t("common:access.via", { group: entry.via ?? "" }) });
    }
    const all = [...map.values()];
    return [...all.filter((row) => row.kind === "group").sort(byName), ...all.filter((row) => row.kind === "user").sort(byName)];
  }, [candidates, members, inherited, toggle, t]);

  const everyoneEditable = Boolean(everyone?.onChange && everyone.options);
  const visibility = Boolean(everyone) && everyone?.publicTag !== false;

  // ── Add: one person or group from those who do not have it yet.
  const granted = new Set(members.map((member) => `${member.subjectType}:${member.subjectId}`));
  const addable = [
    ...(candidates?.groups ?? []).map((c) => ({ kind: "group" as const, ...c })).sort(byName),
    ...(candidates?.users ?? []).map((c) => ({ kind: "user" as const, ...c })).sort(byName)
  ].filter((c) => !granted.has(`${c.kind}:${c.id}`));
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ kind: "user" | "group"; id: string; name: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [addRole, setAddRole] = useState(startRole);
  const inputRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const matches = addable.filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.sub ?? "").toLowerCase().includes(needle)).slice(0, 8);

  const add = async () => {
    if (!picked) return;
    const role = toggle ? "" : addRole;
    if (onGrantMany) await onGrantMany([{ subjectType: picked.kind, subjectId: picked.id }], role);
    else await onGrant(picked.kind, picked.id, role);
    setPicked(null);
    setQuery("");
  };

  // ── Changes. A place that saves its whole list takes several rows as one change;
  // the others get one request at a time, since each reloads its list afterwards and
  // a burst of them would race to be the last word.
  const subjectsOf = (targets: Row[]) => targets.map((row) => ({ subjectType: row.kind, subjectId: row.id }));
  const grantRows = async (targets: Row[], role: string) => {
    const changed = targets.filter((row) => !row.missing && row.role !== role);
    if (changed.length === 0) return;
    if (onGrantMany) {
      await onGrantMany(subjectsOf(changed), role);
      return;
    }
    for (const row of changed) await onGrant(row.kind, row.id, role);
  };
  const removeRows = async (targets: Row[]) => {
    if (targets.length === 0) return;
    if (onRevokeMany) {
      await onRevokeMany(subjectsOf(targets));
      return;
    }
    for (const row of targets) await onRevoke(row.kind, row.id);
  };

  // ── Ticked rows. Only a row with access of its own can be ticked: one that has it
  // through a group is changed there. A tick does not outlive its row.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const tickable = rows.filter((row) => row.role !== null);
  const chosen = tickable.filter((row) => ticked.has(row.key));
  const allChosen = tickable.length > 0 && chosen.length === tickable.length;
  const tick = (key: string) => {
    const next = new Set(ticked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setTicked(next);
  };
  const withChosen = (work: (targets: Row[]) => Promise<void>) => {
    const targets = chosen;
    setTicked(new Set());
    void work(targets);
  };
  const setEveryone = (value: string) => {
    if (!everyone?.onChange) return;
    if (value === ACCESS_NONE) return everyone.onChange(null);
    // An on/off list's "Has access" is whatever the caller calls having it.
    const own = toggle ? everyone.options?.find((option) => option.value !== ACCESS_NONE)?.value : value;
    if (own && everyone.options?.some((option) => option.value === own)) everyone.onChange(own);
  };

  const glossary = roles.filter((role) => !standsApart(role));

  return (
    <div className="access-control">
      {/* Open to everyone, or only to those listed — the thing's one line about it. */}
      {everyone && visibility && (
        <div className={`ax-card${everyone.role ? " is-public" : ""}`}>
          <span className="ax-card-icon" aria-hidden="true">{everyone.role ? <Globe2 size={20} /> : <Lock size={20} />}</span>
          <div>
            <strong>
              {everyone.cardTitle ?? (everyone.role ? t("common:access.cardPublic") : t("common:access.cardPrivate"))}
              <small className={`ax-tag${everyone.role ? "" : " is-muted"}`}>{everyone.role ? t("common:access.public") : t("common:access.private")}</small>
            </strong>
            <span>{everyone.summary ?? everyone.hint}</span>
          </div>
        </div>
      )}

      {candidates && (
        <div className="ax-add">
          <div className="ax-add-field">
            <Search size={17} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={open && !picked && matches.length > 0}
              aria-controls="ax-add-list"
              aria-label={t("common:access.addPlaceholder")}
              placeholder={t("common:access.addPlaceholder")}
              value={picked ? picked.name : query}
              disabled={busy}
              // Opens on a click, typing or Down — not on focus: the window focuses this
              // field when it opens, and the list would cover who already has access.
              onClick={() => setOpen(true)}
              onBlur={() => window.setTimeout(() => setOpen(false), 150)}
              onChange={(event) => { setPicked(null); setQuery(event.target.value); setOpen(true); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (picked) void add();
                  else if (matches[0]) { setPicked(matches[0]); setOpen(false); }
                }
                if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); }
                // With the list open, Escape closes the list, not the window around it.
                if (event.key === "Escape" && open && !picked) { event.preventDefault(); setOpen(false); }
              }}
            />
            {picked && (
              <Button variant="icon" className="ax-add-clear" aria-label={t("common:access.clearPick")} onClick={() => { setPicked(null); setQuery(""); inputRef.current?.focus(); }}>
                <X size={14} aria-hidden="true" />
              </Button>
            )}
            {open && !picked && (
              <div className="ax-add-list" id="ax-add-list" role="listbox">
                {matches.length === 0
                  ? <p className="ax-empty">{addable.length === 0 ? t("common:access.everyoneAdded") : t("common:access.noMatch")}</p>
                  : matches.map((c) => (
                    <Button key={`${c.kind}:${c.id}`} variant="bare" className="ax-add-option" role="option" aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { setPicked({ kind: c.kind, id: c.id, name: c.name }); setOpen(false); }}>
                      <Avatar kind={c.kind} name={c.name} />
                      <span className="ax-name">{c.name}{c.kind === "group" && <small className="ax-kind">{t("common:access.groupLabel")}</small>}</span>
                      {c.sub && <small className="ax-add-sub">{c.sub}</small>}
                    </Button>
                  ))}
              </div>
            )}
          </div>
          {!toggle && <RoleMenu value={addRole} options={roles} label={t("common:access.roleToGrant")} disabled={busy} onChange={setAddRole} />}
          <Button variant="primary" onClick={() => void add()} disabled={busy || !picked}>
            <UserPlus size={16} aria-hidden="true" />
            <span>{t("common:access.add")}</span>
          </Button>
        </div>
      )}

      <div className="ax-list">
        <div className="ax-row ax-head">
          <input
            type="checkbox"
            checked={allChosen}
            ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allChosen; }}
            disabled={busy || tickable.length === 0}
            onChange={() => setTicked(allChosen ? new Set() : new Set(tickable.map((row) => row.key)))}
            aria-label={t("common:access.selectAll")}
          />
          <span className="ax-head-name">
            {chosen.length > 0 ? t("common:access.selected", { count: chosen.length }) : t("common:access.subjectsHead")}
          </span>
          {/* With rows ticked, the column's heading becomes the control that acts on
              all of them — no second bar under the list. */}
          {chosen.length === 0 ? (
            <span className="ax-head-access">{t("common:access.accessHead")}</span>
          ) : toggle ? (
            <Button variant="secondary" compact disabled={busy} onClick={() => withChosen(removeRows)}>{t("common:access.removeAccess")}</Button>
          ) : (
            <RoleMenu
              value={null}
              options={roles}
              label={t("common:access.bulkRole")}
              placeholder={t("common:access.bulkRole")}
              disabled={busy}
              onChange={(role) => withChosen((targets) => grantRows(targets, role))}
              onRemove={() => withChosen(removeRows)}
            />
          )}
        </div>

        {/* Everyone is a row like any other, except that it always exists: nothing
            to tick or remove, only a role to change (where this place lets you). */}
        {everyone && (
          <div className="ax-row" title={everyone.lockedHint ?? everyone.hint}>
            <input type="checkbox" checked={false} disabled readOnly tabIndex={-1} aria-hidden="true" />
            <Avatar kind="everyone" name="" />
            <span className="ax-name">
              <span className="ax-name-line">
                {t("common:access.everyone")}
                {everyone.role && everyone.publicTag !== false && <small className="ax-tag">{t("common:access.public")}</small>}
              </span>
            </span>
            {toggle ? (
              everyoneEditable
                ? <Button variant="secondary" compact disabled={busy} onClick={() => void setEveryone(everyone.role ? ACCESS_NONE : HAS)}
                    aria-label={everyone.role ? t("common:access.removeFor", { name: t("common:access.everyone") }) : t("common:access.giveFor", { name: t("common:access.everyone") })}>
                    {everyone.role ? t("common:access.remove") : t("common:access.add")}
                  </Button>
                : <small className="ax-state">{everyone.role ? t("common:access.hasAccess") : t("common:access.noAccess")}</small>
            ) : (
              <RoleMenu
                value={everyone.role ?? ACCESS_NONE}
                options={everyone.options ?? [...roles, noAccess]}
                label={t("common:access.everyone")}
                disabled={busy || !everyoneEditable}
                onChange={everyoneEditable ? (value) => void setEveryone(value) : undefined}
              />
            )}
          </div>
        )}

        {rows.map((row) => (
          <div className={`ax-row${ticked.has(row.key) && row.role !== null ? " is-selected" : ""}`} key={row.key} title={row.sub}>
            <input
              type="checkbox"
              checked={row.role !== null && ticked.has(row.key)}
              disabled={busy || row.role === null}
              onChange={() => tick(row.key)}
              aria-label={t("common:access.selectRow", { name: row.name })}
            />
            <Avatar kind={row.kind} name={row.name} />
            <span className="ax-name">
              <span className="ax-name-line">
                {row.name}
                {row.kind === "group" && <small className="ax-kind">{t("common:access.groupLabel")}</small>}
              </span>
              {/* A second line only for what the row cannot be read without: that
                  its subject is gone, or where its access comes from. */}
              {row.missing ? <small>{t("common:access.deleted")}</small> : row.via ? <small>{row.via}</small> : null}
            </span>
            {row.role === null ? (
              // Through a group: changed there, not here.
              <small className="ax-state">{t("common:access.throughGroup")}</small>
            ) : toggle ? (
              <Button variant="secondary" compact disabled={busy} onClick={() => void removeRows([row])} aria-label={t("common:access.removeFor", { name: row.name })}>
                {t("common:access.remove")}
              </Button>
            ) : (
              <RoleMenu
                value={row.role}
                options={roles}
                label={t("common:access.roleFor", { name: row.name })}
                disabled={busy}
                // A subject that is gone keeps its role as it was; it can only be removed.
                onChange={row.missing ? undefined : (role) => void grantRows([row], role)}
                onRemove={() => void removeRows([row])}
              />
            )}
          </div>
        ))}

        {rows.length === 0 && !everyone && (
          <p className="ax-empty">{emptyHint !== "" ? emptyHint ?? t("common:access.nobodyYet") : null}</p>
        )}
        {rows.length === 0 && everyone && emptyHint !== "" && (
          <p className="ax-empty">{emptyHint ?? t("common:access.nobodyYet")}</p>
        )}
      </div>

      <p className="ax-saved">
        <Info size={15} aria-hidden="true" />
        <span>{t("common:access.savedAutomatically")}</span>
      </p>

      {/* What each role may do, in the order they escalate — the same objects the
          menus render, so the two can never drift apart. */}
      {showLegend && glossary.length > 0 && (
        <div className="ax-legend">
          <span className="ax-legend-label">{t("common:access.roles")}:</span>
          <dl>
            {glossary.map((role) => (
              <div key={role.value}>
                <dt style={{ color: role.dot }}>{role.label}</dt>
                <dd>{role.tagline}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
