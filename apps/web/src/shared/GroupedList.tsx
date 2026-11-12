import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, ChevronsUpDown, Eye, EyeOff, Search } from "lucide-react";
import { followRoute } from "../router";
import { Button } from "./Button";

// Grouped rows, the way a phone's Settings app lays a page out (first used by
// Applications › Gallery › Device Sync, control panel v2): a group has an optional
// small heading and footnote, and each row says what it is, shows its value, and —
// when it leads somewhere — ends in a chevron. Rows are buttons or links, so the
// whole row is the target, as on a phone. Use it for pages that are mostly state to
// read and one tap to change; tables of many columns stay tables.

export function GroupedList({ title, note, children, id }: { title?: string; note?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="grouped-list" id={id} aria-label={title}>
      {title && <h3 className="grouped-list-title">{title}</h3>}
      <div className="grouped-list-rows">{children}</div>
      {note && <p className="grouped-list-note">{note}</p>}
    </section>
  );
}

type Tone = "ok" | "warn" | "danger" | "muted";

interface RowText {
  /** A small square icon on the left. */
  icon?: ReactNode;
  iconTone?: Tone | "blue" | "gold" | "rose";
  /** `round` for a person or a group: their picture or initials in a circle. */
  iconShape?: "square" | "round";
  label: ReactNode;
  /** A second, smaller line under the label. */
  sub?: ReactNode;
  /** What it is set to, on the right. */
  value?: ReactNode;
  valueTone?: Tone;
}

function RowBody({ icon, iconTone, iconShape, label, sub, value, valueTone, chevron }: RowText & { chevron: boolean }) {
  return (
    <>
      {icon && <span className={`grouped-row-icon${iconTone ? ` is-${iconTone}` : ""}${iconShape === "round" ? " is-round" : ""}`} aria-hidden="true">{icon}</span>}
      <span className="grouped-row-label">
        <strong>{label}</strong>
        {sub && <small>{sub}</small>}
      </span>
      {value !== undefined && value !== null && value !== "" && (
        <span className={`grouped-row-value${valueTone ? ` is-${valueTone}` : ""}`}>{value}</span>
      )}
      {chevron && <ChevronRight className="grouped-row-chevron" size={17} aria-hidden="true" />}
    </>
  );
}

/** A row that leads somewhere: to another address (`href`) or a step in the page (`onClick`). */
export function NavRow({ href, onClick, disabled = false, summary = false, ...text }: RowText & { href?: string; onClick?: () => void; disabled?: boolean; /** Room for a description and status; the status moves below it on phones. */ summary?: boolean }) {
  const className = `grouped-row${summary ? " grouped-row-summary" : ""}`;
  if (href) {
    return (
      <a className={className} href={href} onClick={(event) => followRoute(event, href)}>
        <RowBody {...text} chevron />
      </a>
    );
  }
  return (
    <Button variant="bare" className={className} onClick={onClick} disabled={disabled}>
      <RowBody {...text} chevron />
    </Button>
  );
}

/** A row that opens a page of its own AND has a switch, so the most common change
 *  (on/off) needs no trip into the page: the row's text is one target, the switch
 *  beside it another, never one inside the other. */
export function NavToggleRow({
  href,
  onClick,
  checked,
  onToggle,
  toggleLabel,
  disabled = false,
  ...text
}: RowText & {
  href?: string;
  onClick?: () => void;
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** The switch's accessible name: "<thing>: on/off" reads better than the label alone. */
  toggleLabel: string;
  disabled?: boolean;
}) {
  const main = href
    ? <a className="grouped-row-main" href={href} onClick={(event) => followRoute(event, href)}><RowBody {...text} chevron /></a>
    : <Button variant="bare" className="grouped-row-main" onClick={onClick}><RowBody {...text} chevron /></Button>;
  return (
    <div className="grouped-row grouped-row-split">
      {main}
      <Button
        variant="bare"
        className="grouped-row-switch"
        role="switch"
        aria-checked={checked}
        aria-label={toggleLabel}
        disabled={disabled}
        onClick={() => onToggle(!checked)}
      >
        <span className={`grouped-switch${checked ? " is-on" : ""}`} aria-hidden="true"><i /></span>
      </Button>
    </div>
  );
}

/** A row that does something where it stands (start a backup) — an icon, what it
 *  does, and its state on the right, but no chevron, since it opens nothing. */
export function CommandRow({ onClick, disabled = false, ...text }: RowText & { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="bare" className="grouped-row grouped-row-command" onClick={onClick} disabled={disabled}>
      <RowBody {...text} chevron={false} />
    </Button>
  );
}

/** A row that only says something. */
export function InfoRow(text: RowText) {
  return (
    <div className="grouped-row">
      <RowBody {...text} chevron={false} />
    </div>
  );
}

/** A centred action: `accent` for the thing to do, `danger` for removing. */
export function ActionRow({ label, onClick, tone = "accent", disabled = false, href, download }: { label: ReactNode; onClick?: () => void; tone?: "accent" | "danger"; disabled?: boolean; href?: string; download?: boolean }) {
  // A file to save (a backup) is a plain link the browser downloads, not a route.
  if (href) {
    return (
      <a className={`grouped-row grouped-row-action is-${tone}`} href={href} download={download || undefined}>
        {label}
      </a>
    );
  }
  return (
    <Button variant="bare" className={`grouped-row grouped-row-action is-${tone}`} onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  );
}

/** "+ Add …" at the end of a list. */
export function AddRow({ label, onClick, icon }: { label: ReactNode; onClick: () => void; icon: ReactNode }) {
  return (
    <Button variant="bare" className="grouped-row grouped-row-add" onClick={onClick}>
      <span className="grouped-row-icon" aria-hidden="true">{icon}</span>
      <span className="grouped-row-label"><strong>{label}</strong></span>
    </Button>
  );
}

/** Whatever a row holds that is not one of the above (a field, a form). */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grouped-row grouped-row-field">{children}</div>;
}

/** An on/off switch, the whole row its target; it saves when it is moved. */
export function ToggleRow({ label, sub, checked, onChange, disabled = false }: { label: ReactNode; sub?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <Button variant="bare" className="grouped-row" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="grouped-row-label">
        <strong>{label}</strong>
        {sub && <small>{sub}</small>}
      </span>
      <span className={`grouped-switch${checked ? " is-on" : ""}`} aria-hidden="true"><i /></span>
    </Button>
  );
}

/** One choice of several, ticked when it is the one; choosing it saves. */
export function CheckRow({ label, sub, checked, onSelect, disabled = false }: { label: ReactNode; sub?: ReactNode; checked: boolean; onSelect: () => void; disabled?: boolean }) {
  return (
    <Button variant="bare" className="grouped-row" aria-pressed={checked} disabled={disabled} onClick={onSelect}>
      <span className="grouped-row-label">
        <strong>{label}</strong>
        {sub && <small>{sub}</small>}
      </span>
      {checked && <Check className="grouped-row-check" size={18} aria-hidden="true" />}
    </Button>
  );
}

/** A typed value on one line, the way a phone lays out a field: the label on the
 *  left, the value on the right (with its `unit` after it). `onCommit` runs when the
 *  field is left or Enter is pressed — pages that save as you go save there. */
export function InputRow({
  label,
  sub,
  value,
  onChange,
  onCommit,
  type = "text",
  unit,
  placeholder,
  min,
  max,
  autoComplete = "off",
  disabled = false,
  wide = false,
  trailing
}: {
  label: ReactNode;
  sub?: ReactNode;
  value: string;
  onChange: (next: string) => void;
  onCommit?: () => void;
  type?: "text" | "number" | "email" | "password" | "time";
  unit?: ReactNode;
  placeholder?: string;
  min?: number;
  max?: number;
  autoComplete?: string;
  disabled?: boolean;
  /** A long value (an address, a host name): the field takes more of the row. */
  wide?: boolean;
  /** Something after the field (a show-password button). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const labelId = useId();
  const isPassword = type === "password";
  return (
    <label className={`grouped-row grouped-row-input${wide ? " is-wide" : ""}${disabled ? " is-disabled" : ""}`}>
      <span className="grouped-row-label">
        <strong id={labelId}>{label}</strong>
        {sub && <small>{sub}</small>}
      </span>
      <span className="grouped-row-entry">
        <input
          aria-labelledby={labelId}
          type={isPassword && revealed ? "text" : type}
          value={value}
          placeholder={placeholder}
          min={min}
          max={max}
          inputMode={type === "number" ? "numeric" : undefined}
          autoComplete={autoComplete}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          // A number is replaced rather than edited, as on a phone: entering the
          // field selects what is there.
          onFocus={type === "number" ? (event) => event.target.select() : undefined}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onCommit) {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        {unit && <span className="grouped-row-unit">{unit}</span>}
        {isPassword && (
          <Button
            variant="icon"
            className="grouped-row-reveal"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? t("common.hidePassword") : t("common.showPassword")}
            aria-pressed={revealed}
            tabIndex={-1}
          >
            {revealed ? <EyeOff size={17} /> : <Eye size={17} />}
          </Button>
        )}
        {trailing}
      </span>
    </label>
  );
}

/** One value picked from a few, as a phone shows it: the label on the left, the
 *  choice on the right. A native select underneath, so a phone opens its own wheel.
 *  Saves on change. */
export function PickerRow({
  label,
  sub,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: ReactNode;
  sub?: ReactNode;
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  return (
    <label className={`grouped-row grouped-row-input grouped-row-picker${disabled ? " is-disabled" : ""}`}>
      <span className="grouped-row-label">
        <strong id={labelId}>{label}</strong>
        {sub && <small>{sub}</small>}
      </span>
      <span className="grouped-row-entry">
        <select aria-labelledby={labelId} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronsUpDown className="grouped-row-chevron" size={15} aria-hidden="true" />
      </span>
    </label>
  );
}

/** The search field over a list of rows. */
export function GroupedSearch({ value, onChange, label, placeholder }: { value: string; onChange: (next: string) => void; label: string; placeholder?: string }) {
  return (
    <label className="grouped-search">
      <Search size={16} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input type="search" value={value} placeholder={placeholder ?? label} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** A person's initials for a round row icon. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}
