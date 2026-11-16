import { useId, type ReactNode } from "react";
import { InfoHint } from "../../../../shared/InfoHint";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";

// One feature on the Maps page, as a settings card (shared/SettingsCard's look): its
// icon, name and what it does, with the switch beside them; then the same three facts
// every feature gives — where the data comes from, how it gets here, and what it
// costs — then anything else the feature needs as rows of its own.
export function MapFeatureCard({
  id,
  icon,
  title,
  description,
  info,
  infoLabel,
  checked,
  disabled = false,
  onToggle,
  facts,
  children
}: {
  /** The card's anchor, so control-panel search can land on it. */
  id?: string;
  icon: ReactNode;
  title: string;
  description: string;
  /** The source, its licence, and a link to it — behind the i button. */
  info: ReactNode;
  infoLabel: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  facts: { label: string; value: ReactNode }[];
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} className="settings-card map-feature-card" aria-labelledby={headingId}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div className="map-feature-title">
          {/* A heading, so the page reads as its features (and search and tests find them). */}
          <h3 id={headingId} className="map-feature-name">
            {title}
            <InfoHint label={infoLabel}>{info}</InfoHint>
          </h3>
          <p>{description}</p>
        </div>
        <ToggleSwitch checked={checked} disabled={disabled} onChange={onToggle} ariaLabel={title} />
      </header>
      <div className="map-feature grouped-list">
      <div className="grouped-list-rows">
        {facts.map((fact) => (
          <div key={fact.label} className="grouped-row map-feature-fact">
            <span className="grouped-row-label"><strong>{fact.label}</strong></span>
            <span className="map-feature-fact-value">{fact.value}</span>
          </div>
        ))}
        {children}
      </div>
      </div>
    </section>
  );
}

/** How much of a limit is in use, as a bar with the two ends named under it. */
export function MapFeatureMeter({ used, limit, usedLabel, limitLabel }: { used: number; limit: number; usedLabel: string; limitLabel: string }) {
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="map-feature-meter">
      <div className="map-feature-meter-track" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={usedLabel}>
        {/* Anything kept shows as a sliver, so 4 MB of 2 GB does not read as empty. */}
        <span style={{ width: used > 0 ? `max(${percent}%, 6px)` : 0 }} />
      </div>
      <div className="map-feature-meter-ends">
        <span>{usedLabel}</span>
        <span>{limitLabel}</span>
      </div>
    </div>
  );
}

/** A part of a card under its facts: a named row with its state and its actions. */
export function MapFeaturePart({
  icon,
  title,
  detail,
  info,
  state,
  children
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail: string;
  info?: ReactNode;
  state: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grouped-row map-feature-part">
      {icon && <span className="grouped-row-icon" aria-hidden="true">{icon}</span>}
      <div className="map-feature-part-text">
        <strong>{title}{info}</strong>
        <small>{detail}</small>
      </div>
      <span className="map-feature-state">{state}</span>
      {children && <div className="map-feature-actions">{children}</div>}
    </div>
  );
}
