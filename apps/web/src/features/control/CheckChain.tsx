import { useId, type ReactNode } from "react";
import { Info } from "lucide-react";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";

// A chain of checks, as a picture: something sets out (a phone, a sign-in), passes
// one check after another, and arrives — and under each check is where it goes when
// the answer is No, with what to do about it. Each check says how it stands on THIS
// server (how many it is stopping), so the picture is a status as much as an
// explanation. First used by Device Sync ("How phone backup works").
//
// It is the companion of the video tabs' VideoFlow, which draws a tree of two
// questions; this one is for rules applied in a row. Like it, the card is left out
// on tablets and phones (styles: .check-chain), where a row of checks can't be drawn.

export interface ChainCheck {
  /** The check, as a question ("Allowed network?"). */
  question: string;
  /** How it stands here ("2 networks · 1 phone stopped"). */
  status: string;
  /** `warn` when it is stopping something now; `plain` for one that only explains. */
  tone: "ok" | "warn" | "plain";
  /** Where a No leads ("Refused"), and what that means or what to do. */
  exit: string;
  exitNote: string;
  /** Makes the way out a button to the fix (the phone it is stopping, the list to add to). */
  onFix?: () => void;
}

export function CheckChain({ icon, title, body, aria, learnHref, learnLabel, noLabel, source, end, checks }: {
  icon: ReactNode;
  title: string;
  body: string;
  /** The whole chain in a sentence or two, for a screen reader. */
  aria: string;
  learnHref: string;
  learnLabel: string;
  /** "No", over each way out. */
  noLabel: string;
  /** `warn` colours the line under the name: nothing refuses it, yet it needs a look. */
  source: { icon: ReactNode; title: string; sub: string; warn?: boolean };
  end: { icon: ReactNode; title: string; sub: string; warn?: boolean };
  checks: ChainCheck[];
}) {
  const titleId = useId();
  return (
    <section className="settings-card check-chain" aria-labelledby={titleId}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h3 id={titleId}>{title}</h3>
          <p>{body}</p>
        </div>
        <div className="settings-card-head-actions">
          <a className="video-flow-more" href={learnHref} onClick={(event) => followRoute(event, learnHref)}>
            <Info size={15} aria-hidden="true" />{learnLabel}
          </a>
        </div>
      </header>
      <ol className="check-chain-row" aria-label={aria} style={{ "--chain-checks": checks.length } as React.CSSProperties}>
        <li className={`check-chain-end${source.warn ? " is-warn" : ""}`}>
          <span aria-hidden="true">{source.icon}</span>
          <strong>{source.title}</strong>
          <small>{source.sub}</small>
        </li>
        {checks.map((check, index) => (
          <li key={index} className={`check-chain-step is-${check.tone}`}>
            <span className="check-chain-ask">
              <strong>{check.question}</strong>
              <small>{check.status}</small>
            </span>
            <span className="check-chain-no" aria-hidden="true">{noLabel}</span>
            {check.onFix ? (
              <Button variant="bare" className="check-chain-exit is-fix" onClick={check.onFix}>
                <strong>{check.exit}</strong>
                <small>{check.exitNote}</small>
              </Button>
            ) : (
              <span className="check-chain-exit">
                <strong>{check.exit}</strong>
                <small>{check.exitNote}</small>
              </span>
            )}
          </li>
        ))}
        <li className={`check-chain-end is-arrival${end.warn ? " is-warn" : ""}`}>
          <span aria-hidden="true">{end.icon}</span>
          <strong>{end.title}</strong>
          <small>{end.sub}</small>
        </li>
      </ol>
    </section>
  );
}
