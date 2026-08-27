import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, CircleQuestionMark, Info, ShieldCheck, type LucideIcon } from "lucide-react";
import i18n from "../../../i18n";
import { Tooltip } from "../../../shared/Tooltip";

// The protection score behind Security › Overview. Nine settings are each
// graded strong / medium / weak, and each carries one weight. A home-only
// server sits the same exam, but the questions that only matter against
// strangers are waived — credited in full whatever the setting says — and a
// couple are half-waived. Same settings therefore never score lower at home
// than on the internet; at home they can only score higher.
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
  proxy: { trustProxyHops: number; trustProxyAddresses: string[]; configured: boolean; forwardedHeaderSeen: boolean };
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
  /** How much this setting counts. */
  weight: number;
  /** The share of the weight a home-only server is credited without being graded:
   *  1 = waived outright, 0.5 = half of it still counts, 0 = graded in full. */
  waivedAtHome: 0 | 0.5 | 1;
}

const LEVEL_POINTS: Record<Level, number> = { strong: 1, medium: 0.5, weak: 0 };

export function gradePolicies({ policy, proxy, passwordPolicy, mailConfigured, trustedNetworkCount }: GradeInput): PolicyGrade[] {
  const proxyAttention = proxy.forwardedHeaderSeen && !proxy.configured;
  const t = i18n.t.bind(i18n);
  return [
    {
      key: "proxy",
      label: t("controlAdmin:protection.labelProxy"),
      value: proxyAttention
        ? t("controlAdmin:protection.needsAttention")
        : proxy.trustProxyAddresses.length > 0
          ? t("controlAdmin:protection.proxyAddresses", { count: proxy.trustProxyAddresses.length })
          : proxy.configured
            ? t("controlAdmin:protection.proxyHops", { count: proxy.trustProxyHops })
            : t("controlAdmin:protection.directConnection"),
      note: proxyAttention
        ? t("controlAdmin:protection.proxyNoteAttention")
        : proxy.trustProxyAddresses.length > 0
          ? t("controlAdmin:protection.proxyNoteAddresses")
          : proxy.configured
            ? t("controlAdmin:protection.proxyNoteHops")
            : t("controlAdmin:protection.proxyNoteDirect"),
      // A trusted proxy is a layer in its own right: TLS ends there, the app is
      // hidden behind it, and the client address is read correctly. Direct is
      // only half that. The weak case is a proxy that is there but not trusted —
      // then every other rule misreads who is knocking.
      level: proxyAttention ? "weak" : proxy.configured ? "strong" : "medium",
      issue: proxyAttention,
      // Inside the house there is nothing to front.
      weight: 3,
      waivedAtHome: 1
    },
    {
      key: "lockout",
      label: t("controlAdmin:protection.labelLockout"),
      value: t("controlAdmin:protection.minutesValue", { count: policy.lockoutMinutes }),
      note: t("controlAdmin:protection.lockoutNote", { count: policy.lockoutThreshold }),
      level: policy.lockoutThreshold <= 5 ? "strong" : policy.lockoutThreshold <= 10 ? "medium" : "weak",
      issue: false,
      weight: 2,
      waivedAtHome: 0
    },
    {
      key: "autoblock",
      label: t("controlAdmin:protection.labelAutoblock"),
      value: t("controlAdmin:protection.minutesValue", { count: policy.ipAutoblockMinutes }),
      note: t("controlAdmin:protection.autoblockNote", { count: policy.ipFailThreshold, minutes: policy.ipFailWindowMinutes }),
      level:
        policy.ipFailThreshold <= 20 && policy.ipAutoblockMinutes >= 30 ? "strong" : policy.ipFailThreshold <= 50 ? "medium" : "weak",
      issue: false,
      weight: 2,
      waivedAtHome: 0
    },
    {
      key: "mfa",
      label: t("controlAdmin:protection.labelMfa"),
      value: policy.requireMfaOutside ? t("controlAdmin:protection.required") : t("controlAdmin:protection.optional"),
      note: policy.requireMfaOutside
        ? mailConfigured ? t("controlAdmin:protection.mfaNoteFallback") : t("controlAdmin:protection.mfaNoteNoMail")
        : t("controlAdmin:protection.mfaNotePerAccount"),
      level: policy.requireMfaOutside ? (mailConfigured ? "strong" : "medium") : "medium",
      issue: policy.requireMfaOutside && !mailConfigured,
      // Inside the house there is no "outside" to require it from.
      weight: 3,
      waivedAtHome: 1
    },
    {
      key: "alerts",
      label: t("controlAdmin:protection.labelAlerts"),
      value: policy.alertNewIpSignIn ? t("controlAdmin:protection.on") : t("controlAdmin:protection.off"),
      note: policy.alertNewIpSignIn
        ? mailConfigured ? t("controlAdmin:protection.alertsNoteOn") : t("controlAdmin:protection.alertsNoteNoMail")
        : t("controlAdmin:protection.alertsNoteOff"),
      level: policy.alertNewIpSignIn ? (mailConfigured ? "strong" : "medium") : "weak",
      issue: policy.alertNewIpSignIn && !mailConfigured,
      // Facing the internet this is how an admin hears about a problem at all,
      // so it counts with proxy trust and the second factor. On a home-only
      // server every sign-in is from the house and it has less to announce, so
      // half of it is waived.
      weight: 3,
      waivedAtHome: 0.5
    },
    {
      key: "deletes",
      label: t("controlAdmin:protection.labelDeletes"),
      value: policy.trustedDeletesOnly ? t("controlAdmin:protection.trustedOnly") : t("controlAdmin:protection.fromAnywhere"),
      note: policy.trustedDeletesOnly
        ? trustedNetworkCount > 0 ? t("controlAdmin:protection.deletesNoteOn") : t("controlAdmin:protection.deletesNoteNoNetworks")
        : t("controlAdmin:protection.deletesNoteOff"),
      level: policy.trustedDeletesOnly ? (trustedNetworkCount > 0 ? "strong" : "medium") : "weak",
      issue: policy.trustedDeletesOnly && trustedNetworkCount === 0,
      // Refusing deletes from outside means nothing when there is no outside.
      weight: 1,
      waivedAtHome: 1
    },
    {
      key: "devices",
      label: t("controlAdmin:protection.labelDevices"),
      value: policy.deviceLinkScope === "local" ? t("controlAdmin:protection.homeOnly") : t("controlAdmin:protection.fromAnywhere"),
      note: policy.deviceLinkScope === "local" ? t("controlAdmin:protection.devicesNoteLocal") : t("controlAdmin:protection.devicesNoteAny"),
      level: policy.deviceLinkScope === "local" ? "strong" : "weak",
      issue: false,
      weight: 1,
      waivedAtHome: 0.5
    },
    {
      key: "password",
      label: t("controlAdmin:protection.labelPassword"),
      value: passwordPolicy.requireComplexity
        ? t("controlAdmin:protection.pwValueMixed", { count: passwordPolicy.minLength })
        : t("controlAdmin:protection.pwValue", { count: passwordPolicy.minLength }),
      note: passwordPolicy.requireComplexity
        ? t("controlAdmin:protection.pwNoteComplex")
        : t("controlAdmin:protection.pwNoteLength"),
      // Eight characters alone is the floor, not a defence; the mix is what
      // keeps a guessed word from being the password.
      level:
        passwordPolicy.minLength < 8 ? "weak" : passwordPolicy.requireComplexity ? "strong" : "medium",
      issue: false,
      weight: 2,
      waivedAtHome: 0
    },
    {
      key: "reputation",
      label: t("controlAdmin:protection.labelReputation"),
      value: policy.hasAbuseIpdbKey ? t("controlAdmin:protection.repConnected") : t("controlAdmin:protection.repNotConnected"),
      note: policy.hasAbuseIpdbKey
        ? policy.reputationAutoEscalate
          ? t("controlAdmin:protection.repNoteEscalate", { count: policy.reputationEscalateThreshold })
          : t("controlAdmin:protection.repNoteOnRequest")
        : t("controlAdmin:protection.repNoteAddKey"),
      level: policy.hasAbuseIpdbKey ? (policy.reputationAutoEscalate ? "strong" : "medium") : "weak",
      issue: false,
      // Strangers' addresses are what reputation scores; a home-only server sees none.
      weight: 1,
      waivedAtHome: 1
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
  counts: { active: number; optional: number; off: number; issues: number };
  /** Settings credited in full because the server is home-only. */
  waived: PolicyGrade[];
}

// Reads the live i18n instance directly rather than taking a `t` parameter —
// TFunction's generic type (tied to the caller's namespace tuple) doesn't
// assign cleanly to a plain function type. The containing component already
// re-renders on language change via its own useTranslation() call, so this
// picks up the current language too. Each branch spells out its literal keys
// (rather than building a "controlAdmin:protection.${x}" template) because a
// template-literal key doesn't type-check against the closed key union t()
// expects.
function levelCopy(level: ProtectionLevel) {
  switch (level) {
    case "strong":
      return { word: i18n.t("controlAdmin:protection.strongWord"), line: i18n.t("controlAdmin:protection.strongLine"), detail: i18n.t("controlAdmin:protection.strongDetail") };
    case "good":
      return { word: i18n.t("controlAdmin:protection.goodWord"), line: i18n.t("controlAdmin:protection.goodLine"), detail: i18n.t("controlAdmin:protection.goodDetail") };
    case "fair":
      return { word: i18n.t("controlAdmin:protection.fairWord"), line: i18n.t("controlAdmin:protection.fairLine"), detail: i18n.t("controlAdmin:protection.fairDetail") };
    case "weak":
      return { word: i18n.t("controlAdmin:protection.weakWord"), line: i18n.t("controlAdmin:protection.weakLine"), detail: i18n.t("controlAdmin:protection.weakDetail") };
    case "critical":
      return { word: i18n.t("controlAdmin:protection.criticalWord"), line: i18n.t("controlAdmin:protection.criticalLine"), detail: i18n.t("controlAdmin:protection.criticalDetail") };
  }
}

export function scoreProtection(grades: PolicyGrade[], exposure: Exposure): ProtectionScore {
  // Every setting is in the denominator for both exposures. At home the waived
  // share of a weight is earned outright; only the rest is graded.
  const total = grades.reduce((sum, grade) => sum + grade.weight, 0);
  const earned = grades.reduce((sum, grade) => {
    const waived = exposure === "internal" ? grade.waivedAtHome : 0;
    return sum + grade.weight * (waived + (1 - waived) * LEVEL_POINTS[grade.level]);
  }, 0);
  const score = total > 0 ? Math.round((earned / total) * 100) : 100;
  const waived = exposure === "internal" ? grades.filter((grade) => grade.waivedAtHome === 1) : [];
  // A waived setting is satisfied by circumstance, so it counts as active.
  const graded = grades.filter((grade) => !waived.includes(grade));
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
      active: waived.length + graded.filter((grade) => grade.level === "strong").length,
      optional: graded.filter((grade) => grade.level === "medium").length,
      off: graded.filter((grade) => grade.level === "weak").length,
      issues: grades.filter((grade) => grade.issue).length
    },
    waived
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
  proxyConfigured,
  saving,
  onExposureChange
}: {
  grades: PolicyGrade[];
  exposure: Exposure;
  /** Requests are arriving through a proxy — a hint that "home only" may be wrong. */
  proxySeen: boolean;
  /** …and it is trusted, so whoever set it up knows it is there: a quieter hint. */
  proxyConfigured: boolean;
  saving: boolean;
  onExposureChange: (next: Exposure) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const result = scoreProtection(grades, exposure);
  const copy = levelCopy(result.level);
  const counters: { icon: LucideIcon; value: number; label: string; tone: string }[] = [
    { icon: CircleCheck, value: result.counts.active, label: t("controlAdmin:protection.countersActive"), tone: "good" },
    { icon: CircleQuestionMark, value: result.counts.optional, label: t("controlAdmin:protection.countersOptional"), tone: "warn" },
    { icon: CircleAlert, value: result.counts.off, label: t("controlAdmin:protection.countersOff"), tone: "bad" },
    { icon: Info, value: result.counts.issues, label: t("controlAdmin:protection.countersIssues"), tone: "info" }
  ];

  return (
    <section className={`protection-card level-${result.level}`} aria-label={t("controlAdmin:protection.cardAria")}>
      <div className="protection-head">
        <h3>
          {t("controlAdmin:protection.heading")}
          <Tooltip
            label={
              exposure === "internet"
                ? t("controlAdmin:protection.tooltipInternet")
                : t("controlAdmin:protection.tooltipInternal")
            }
          >
            <Info size={15} aria-hidden="true" />
          </Tooltip>
        </h3>
        {/* The one input the server can't measure. Saved on the spot. */}
        <div className="range-picker protection-exposure" role="group" aria-label={t("controlAdmin:protection.exposureGroupAria")}>
          <button
            type="button"
            className={exposure === "internal" ? "active" : undefined}
            aria-pressed={exposure === "internal"}
            disabled={saving}
            onClick={() => onExposureChange("internal")}
          >
            {t("controlAdmin:protection.homeNetworkOnly")}
          </button>
          <button
            type="button"
            className={exposure === "internet" ? "active" : undefined}
            aria-pressed={exposure === "internet"}
            disabled={saving}
            onClick={() => onExposureChange("internet")}
          >
            {t("controlAdmin:protection.reachableInternet")}
          </button>
        </div>
      </div>

      {proxySeen && exposure === "internal" && (
        <p className="protection-hint">
          {proxyConfigured
            ? t("controlAdmin:protection.hintProxyTrusted")
            : t("controlAdmin:protection.hintProxyUntrusted")}
        </p>
      )}

      <div className="protection-body">
        <div className="protection-gauge" role="img" aria-label={t("controlAdmin:protection.gaugeAria", { score: result.score, word: copy.word })}>
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
          {result.waived.length > 0 && (
            <p className="protection-note">
              {t("controlAdmin:protection.waivedNote", { count: result.waived.length, list: result.waived.map((grade) => grade.label).join(", ") })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
