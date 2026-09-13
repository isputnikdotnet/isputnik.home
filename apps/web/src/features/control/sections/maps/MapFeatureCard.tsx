import type { ReactNode } from "react";
import { InfoHint } from "../../../../shared/InfoHint";
import { ToggleSwitch } from "../../../../shared/ToggleSwitch";

// One feature on the Maps page: what it does in a line, a switch, and the same
// three facts every card gives — where the data comes from, how it gets here, and
// what it costs. Anything the feature needs beyond the switch sits under them.
export function MapFeatureCard({
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
  return (
    <section className="map-feature">
      <div className="map-feature-head">
        <span className="map-feature-icon" aria-hidden="true">{icon}</span>
        <div className="map-feature-title">
          <h2>
            {title}
            <InfoHint label={infoLabel}>{info}</InfoHint>
          </h2>
          <p>{description}</p>
        </div>
        <ToggleSwitch checked={checked} disabled={disabled} onChange={onToggle} ariaLabel={title} />
      </div>
      <dl className="map-feature-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}

/** A part of a card under its facts: a named row with its state and its actions. */
export function MapFeaturePart({
  title,
  detail,
  info,
  state,
  children
}: {
  title: ReactNode;
  detail: string;
  info?: ReactNode;
  state: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="map-feature-part">
      <div className="map-feature-part-text">
        <strong>{title}{info}</strong>
        <small>{detail}</small>
      </div>
      <span className="map-feature-state">{state}</span>
      {children && <div className="map-feature-actions">{children}</div>}
    </div>
  );
}
