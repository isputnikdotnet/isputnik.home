import { CircleAlert, CircleCheck, CircleQuestionMark, Info, ShieldCheck, type LucideIcon } from "lucide-react";
import { Tooltip } from "../../../shared/Tooltip";

// The protection score behind Security › Overview. Eight settings are each
// graded strong / medium / weak; each carries a weight that depends on how the
// server is reached. A home-only install is graded gently on the defences that
// only matter against strangers (a second factor from outside, IP reputation),
// and an internet-facing one is not — the same settings, a different exam.
//
// The grades are also what the Policies table under the card draws, so the
// card and the table can never disagree about a row.

export type Exposure = "internal" | "internet";
export type Level = "strong" | "medium" | "weak";

export interface GradeInput {
  policy: {
    lockoutThreshold: number;
    lockoutMinutes: number;
    ipFailThreshold: number;
    ipFailWindowMinutes: number;
    ipAutoblockMinutes: number;
    alertNewIpSignIn: boolean;
    deviceLinkScope: "local" | "any";
    requireMfaOutside: boolean;
    hasAbuseIpdbKey: boolean;
    reputationAutoEscalate: boolean;
    reputationEscalateThreshold: number;
    trustedDeletesOnly: boolean;
  };
  proxy: { trustProxyHops: number; configured: boolean; forwardedHeaderSeen: boolean };
  passwordPolicy: { minLength: number; requireComplexity: boolean };
  mailConfigured: boolean;
  trustedNetworkCount: number;
}

export interface PolicyGrade {
  key: string;
  label: string;
  value: string;
  note: string;
  level: Level;
  /** A setting that is on but cannot do its job — a proxy without trust, an alert without email. */
  issue: boolean;
  /** How much this setting counts, per way the server is reached. Zero = not needed. */
  weight: Record<Exposure, number>;
}

const LEVEL_POINTS: Record<Level, number> = { strong: 1, medium: 0.5, weak: 0 };

export function gradePolicies({ policy, proxy, passwordPolicy, mailConfigured, trustedNetworkCount }: GradeInput): PolicyGrade[] {
  const proxyAttention = proxy.forwardedHeaderSeen && !proxy.configured;
  return [
    {
      key: "proxy",
      label: "Proxy trust",
      value: proxyAttention ? "Needs attention" : proxy.configured ? `${proxy.trustProxyHops} hop${proxy.trustProxyHops === 1 ? "" : "s"} trusted` : "Direct connection",
      note: proxyAttention
        ? "Requests carry X-Forwarded-For but TRUST_PROXY_HOPS is not set — every visitor may look like the proxy"
        : proxy.configured
          ? "A reverse proxy fronts the app and the client address is read past it"
          : "No reverse proxy in front — fine at home, a thin front door on the internet",
      // A trusted proxy is a layer in its own right: TLS ends there, the app is
      // hidden behind it, and the client address is read correctly. Direct is
      // only half that. The weak case is a proxy that is there but not trusted —
      // then every other rule misreads who is knocking.
      level: proxyAttention ? "weak" : proxy.configured ? "strong" : "medium",
      issue: proxyAttention,
      // Inside the house there is nothing to front.
      weight: { internal: 0, internet: 3 }
    },
    {
      key: "lockout",
      label: "Account lockout",
      value: `${policy.lockoutMinutes} min`,
      note: `After ${policy.lockoutThreshold} failed sign-ins`,
      level: policy.lockoutThreshold <= 5 ? "strong" : policy.lockoutThreshold <= 10 ? "medium" : "weak",
      issue: false,
      weight: { internal: 1, internet: 2 }
    },
    {
      key: "autoblock",
      label: "IP auto-block",
      value: `${policy.ipAutoblockMinutes} min`,
      note: `After ${policy.ipFailThreshold} failures within ${policy.ipFailWindowMinutes} min`,
      level:
        policy.ipFailThreshold <= 20 && policy.ipAutoblockMinutes >= 30 ? "strong" : policy.ipFailThreshold <= 50 ? "medium" : "weak",
      issue: false,
      weight: { internal: 1, internet: 2 }
    },
    {
      key: "mfa",
      label: "Two-factor outside the house",
      value: policy.requireMfaOutside ? "Required" : "Optional",
      note: policy.requireMfaOutside
        ? mailConfigured ? "Email fallback for anyone not enrolled" : "Email is not set up — the un-enrolled have no fallback"
        : "Per-account enrollment only",
      level: policy.requireMfaOutside ? (mailConfigured ? "strong" : "medium") : "medium",
      issue: policy.requireMfaOutside && !mailConfigured,
      // Inside the house there is no "outside" to require it from.
      weight: { internal: 0, internet: 3 }
    },
    {
      key: "alerts",
      label: "Sign-in alerts",
      value: policy.alertNewIpSignIn ? "On" : "Off",
      note: policy.alertNewIpSignIn
        ? mailConfigured ? "Emailed when an account signs in from a new network" : "On, but email is not set up"
        : "A sign-in from a new network is not announced",
      level: policy.alertNewIpSignIn ? (mailConfigured ? "strong" : "medium") : "weak",
      issue: policy.alertNewIpSignIn && !mailConfigured,
      // Facing the internet this is how an admin hears about a problem at all,
      // so it counts with proxy trust and the second factor. On a home-only
      // server every sign-in is from the house, and it has little to announce.
      weight: { internal: 0.5, internet: 3 }
    },
    {
      key: "deletes",
      label: "Deletion protection",
      value: policy.trustedDeletesOnly ? "Trusted networks only" : "From anywhere",
      note: policy.trustedDeletesOnly
        ? trustedNetworkCount > 0 ? "Deletes are refused from outside the house" : "On, but no trusted network is defined — deletes are refused everywhere"
        : "Anyone signed in can delete from any network",
      level: policy.trustedDeletesOnly ? (trustedNetworkCount > 0 ? "strong" : "medium") : "weak",
      issue: policy.trustedDeletesOnly && trustedNetworkCount === 0,
      // Refusing deletes from outside means nothing when there is no outside.
      weight: { internal: 0, internet: 1 }
    },
    {
      key: "devices",
      label: "Device linking",
      value: policy.deviceLinkScope === "local" ? "Home network only" : "From anywhere",
      note: policy.deviceLinkScope === "local" ? "A TV can only be linked from inside the house" : "Linking can be started from the internet",
      level: policy.deviceLinkScope === "local" ? "strong" : "weak",
      issue: false,
      weight: { internal: 0.5, internet: 1 }
    },
    {
      key: "password",
      label: "Password policy",
      value: `${passwordPolicy.minLength}+ characters${passwordPolicy.requireComplexity ? ", mixed" : ""}`,
      note: passwordPolicy.requireComplexity
        ? "At least three of: lowercase, uppercase, numbers, symbols"
        : "Length only — any characters will do",
      // Eight characters alone is the floor, not a defence; the mix is what
      // keeps a guessed word from being the password.
      level:
        passwordPolicy.minLength < 8 ? "weak" : passwordPolicy.requireComplexity ? "strong" : "medium",
      issue: false,
      weight: { internal: 1, internet: 2 }
    },
    {
      key: "reputation",
      label: "IP reputation",
      value: policy.hasAbuseIpdbKey ? "AbuseIPDB connected" : "Not connected",
      note: policy.hasAbuseIpdbKey
        ? policy.reputationAutoEscalate ? `Blocks go permanent above ${policy.reputationEscalateThreshold}% confidence` : "Scores shown on request"
        : "Add a key to score blocked addresses",
      level: policy.hasAbuseIpdbKey ? (policy.reputationAutoEscalate ? "strong" : "medium") : "weak",
      issue: false,
      // Strangers' addresses are what reputation scores; a home-only server sees none.
      weight: { internal: 0, internet: 1 }
    }
  ];
}

export type ProtectionLevel = "critical" | "weak" | "fair" | "good" | "strong";

export interface ProtectionScore {
  score: number;
  level: ProtectionLevel;
  /** Where the marker sits on the five-band bar, 0–100. The bands are levels,
   *  not equal slices of the score, so this maps the score into its band. */
  barPosition: number;
  counts: { active: number; optional: number; off: number; issues: number; notNeeded: number };
}

const LEVEL_COPY: Record<ProtectionLevel, { word: string; line: string; detail: string }> = {
  strong: {
    word: "Strong",
    line: "You're well protected.",
    detail: "Your settings block the common threats and layer several protections."
  },
  good: {
    word: "Good",
    line: "Mostly protected.",
    detail: "A setting or two could be tighter — the amber and red rows below say which."
  },
  fair: {
    word: "Fair",
    line: "Partly protected.",
    detail: "Several protections are off or weak for the way this server is reached."
  },
  weak: {
    word: "Weak",
    line: "Thinly protected.",
    detail: "Most of the protections that matter here are off. Start with the red rows."
  },
  critical: {
    word: "Critical",
    line: "Exposed.",
    detail: "Almost nothing stands between a stranger and the sign-in screen."
  }
};

export function scoreProtection(grades: PolicyGrade[], exposure: Exposure): ProtectionScore {
  const weighted = grades.filter((grade) => grade.weight[exposure] > 0);
  const total = weighted.reduce((sum, grade) => sum + grade.weight[exposure], 0);
  const earned = weighted.reduce((sum, grade) => sum + grade.weight[exposure] * LEVEL_POINTS[grade.level], 0);
  const score = total > 0 ? Math.round((earned / total) * 100) : 100;
  const level: ProtectionLevel =
    score >= 85 ? "strong" : score >= 65 ? "good" : score >= 45 ? "fair" : score >= 25 ? "weak" : "critical";
  const bands: [ProtectionLevel, number, number][] = [
    ["critical", 0, 25],
    ["weak", 25, 45],
    ["fair", 45, 65],
    ["good", 65, 85],
    ["strong", 85, 100]
  ];
  const bandIndex = bands.findIndex(([name]) => name === level);
  const [, low, high] = bands[bandIndex];
  const within = Math.min(1, Math.max(0, (score - low) / (high - low)));
  const barPosition = ((bandIndex + within) / bands.length) * 100;
  return {
    score,
    level,
    barPosition,
    counts: {
      active: weighted.filter((grade) => grade.level === "strong").length,
      optional: weighted.filter((grade) => grade.level === "medium").length,
      off: weighted.filter((grade) => grade.level === "weak").length,
      issues: grades.filter((grade) => grade.issue).length,
      notNeeded: grades.length - weighted.length
    }
  };
}

// The ring is a full circle drawn as a dashed stroke; the dash is the score's
// share of the circumference, rotated so it starts at the top.
const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function ProtectionCard({
  grades,
  exposure,
  proxySeen,
  saving,
  onExposureChange
}: {
  grades: PolicyGrade[];
  exposure: Exposure;
  /** Requests are arriving through a proxy — a hint that "home only" may be wrong. */
  proxySeen: boolean;
  saving: boolean;
  onExposureChange: (next: Exposure) => void;
}) {
  const result = scoreProtection(grades, exposure);
  const copy = LEVEL_COPY[result.level];
  const counters: { icon: LucideIcon; value: number; label: string; tone: string }[] = [
    { icon: CircleCheck, value: result.counts.active, label: "Active policies", tone: "good" },
    { icon: CircleQuestionMark, value: result.counts.optional, label: "Optional", tone: "warn" },
    { icon: CircleAlert, value: result.counts.off, label: "Off", tone: "bad" },
    { icon: Info, value: result.counts.issues, label: "Issues", tone: "info" }
  ];

  return (
    <section className={`protection-card level-${result.level}`} aria-label="Protection level">
      <div className="protection-head">
        <h3>
          Protection level
          <Tooltip
            label={
              exposure === "internet"
                ? "Graded for a server reachable from the internet: every protection counts, and proxy trust, a second factor from outside and sign-in alerts count most — they are how you keep strangers out and hear about the ones who got close."
                : "Graded for a server on the home network only: the defences that only matter against strangers — proxy trust, a second factor from outside, deletion protection, IP reputation — are not counted at all."
            }
          >
            <Info size={15} aria-hidden="true" />
          </Tooltip>
        </h3>
        {/* The one input the server can't measure. Saved on the spot. */}
        <div className="range-picker protection-exposure" role="group" aria-label="How this server is reached">
          <button
            type="button"
            className={exposure === "internal" ? "active" : undefined}
            aria-pressed={exposure === "internal"}
            disabled={saving}
            onClick={() => onExposureChange("internal")}
          >
            Home network only
          </button>
          <button
            type="button"
            className={exposure === "internet" ? "active" : undefined}
            aria-pressed={exposure === "internet"}
            disabled={saving}
            onClick={() => onExposureChange("internet")}
          >
            Reachable from the internet
          </button>
        </div>
      </div>

      {proxySeen && exposure === "internal" && (
        <p className="protection-hint">
          Requests are arriving through a proxy. If this server can be reached from the internet, say so above —
          the grading is gentler than it should be until then.
        </p>
      )}

      <div className="protection-body">
        <div className="protection-gauge" role="img" aria-label={`${result.score} out of 100 — ${copy.word}`}>
          <svg viewBox="0 0 128 128" aria-hidden="true">
            <circle className="protection-ring-track" cx="64" cy="64" r={RING_RADIUS} />
            <circle
              className="protection-ring-fill"
              cx="64"
              cy="64"
              r={RING_RADIUS}
              strokeDasharray={`${(result.score / 100) * RING_LENGTH} ${RING_LENGTH}`}
            />
          </svg>
          <span className="protection-shield" aria-hidden="true">
            <ShieldCheck size={40} strokeWidth={2.2} />
          </span>
        </div>

        <div className="protection-copy">
          <strong className="protection-word">
            {copy.word}
            <span className="protection-score">{result.score}<small>/100</small></span>
          </strong>
          <span className="protection-line">{copy.line}</span>
          <p className="protection-detail">{copy.detail}</p>

          {/* Five bands, the marker at the score. */}
          <div className="protection-bar" aria-hidden="true">
            {["critical", "weak", "fair", "good", "strong"].map((band) => (
              <span key={band} className={`protection-band band-${band}`} />
            ))}
            <span className="protection-marker" style={{ left: `${result.barPosition}%` }} />
          </div>

          <dl className="protection-counts">
            {counters.map((counter) => {
              const Icon = counter.icon;
              return (
                <div key={counter.label}>
                  <dt>
                    <Icon size={18} aria-hidden="true" className={`protection-count-icon tone-${counter.tone}`} />
                    <strong>{counter.value}</strong>
                  </dt>
                  <dd>{counter.label}</dd>
                </div>
              );
            })}
          </dl>
          {result.counts.notNeeded > 0 && (
            <p className="protection-note">
              {result.counts.notNeeded} {result.counts.notNeeded === 1 ? "setting is" : "settings are"} not counted for a
              home-only server.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
