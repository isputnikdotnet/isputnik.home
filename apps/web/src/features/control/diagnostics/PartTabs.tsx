import type { ReactNode } from "react";
import { diagnosticsPartHref, followRoute, type DiagnosticsPart, type DiagnosticsTab } from "../../../router";
import { RouteTab } from "../../../shared/RouteTab";

// A part page's ONE row of tabs (Diagnostics › iSputnik, Diagnostics › Video):
// every tab a real address (diagnosticsPartHref), the label carrying a count
// where it has one (Live sessions 1, Reports 3). docs/UI-CONVENTIONS.md allows a
// page of one thing its own row; the side column follows each tab's own rule.

export function PartTabs({ part, tabs, current, label, aria }: {
  part: DiagnosticsPart;
  tabs: readonly DiagnosticsTab[];
  current: DiagnosticsTab;
  label: (tab: DiagnosticsTab) => ReactNode;
  aria: string;
}) {
  return (
    <div className="control-tabs diag-video-tabs" role="tablist" aria-label={aria}>
      {tabs.map((id) => (
        <RouteTab key={id} selected={id === current} className={id === current ? "active" : undefined} href={diagnosticsPartHref(part, id)} onClick={followRoute}>
          {label(id)}
        </RouteTab>
      ))}
    </div>
  );
}

/** "3", beside a tab's name; nothing for none. */
export function TabCount({ count }: { count: number | null | undefined }) {
  return count ? <span className="diag-tab-count">{count}</span> : null;
}
