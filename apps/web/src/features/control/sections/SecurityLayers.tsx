import { useTranslation } from "react-i18next";
import { Globe, LibraryBig, ShieldCheck } from "lucide-react";
import { controlHref, navigate } from "../../../router";
import { CheckChain, type ChainCheck } from "../CheckChain";
import { levelCopy, scoreProtection, type Exposure, type PolicyGrade } from "./SecurityProtection";

// Security › Overview's picture of the server's protection: the four layers that
// count most between the internet and the library, from the outside in — proxy
// trust, IP auto-block, the second factor, sign-in alerts (the owner's pick,
// 2026-11-23, and the heaviest weights in the score). Each wears the grade the
// Policies table under it gives the same setting, says what it is set to, and under
// it what it stops. The other five settings stay in the table.
//
// A layer a home-only server is not held to (waived in the score) goes plain and
// says so, rather than amber for a setting nobody needs there.

export interface SecurityLayersProps {
  grades: PolicyGrade[];
  exposure: Exposure;
  policy: { ipFailThreshold: number; requireMfaOutside: boolean };
  posture: { failed24h: number; blocked: { live: number; permanent: number }; mfa: { enrolled: number; total: number } };
}

export function SecurityLayers({ grades, exposure, policy, posture }: SecurityLayersProps) {
  const { t } = useTranslation(["controlAdmin"]);
  const layer = (key: string, own?: string): Pick<ChainCheck, "tone" | "status" | "badge"> => {
    const grade = grades.find((candidate) => candidate.key === key);
    if (!grade) return { tone: "plain", status: own ?? "" };
    if (exposure === "internal" && grade.waivedAtHome === 1 && !grade.issue) return { tone: "plain", status: t("controlAdmin:security.flow.notAtHome") };
    return {
      tone: grade.issue || grade.level === "weak" ? "warn" : grade.level === "strong" ? "ok" : "plain",
      status: own ?? grade.value,
      badge: grade.level === "strong" ? t("controlAdmin:security.pillStrong") : grade.level === "medium" ? t("controlAdmin:security.pillMedium") : t("controlAdmin:security.pillWeak")
    };
  };
  const policyAt = (anchor: string) => () => navigate(`${controlHref("securityPolicies")}#${anchor}`);
  const blocked = posture.blocked.live + posture.blocked.permanent;

  return (
    <CheckChain
      icon={<ShieldCheck size={22} />}
      title={t("controlAdmin:security.flow.title")}
      body={t("controlAdmin:security.flow.body")}
      aria={t("controlAdmin:security.flow.aria")}
      learnHref="/help/exposing-to-the-internet"
      learnLabel={t("controlAdmin:apps.videoHero.learnMore")}
      exitLabel={t("controlAdmin:security.flow.stops")}
      source={{
        icon: <Globe size={24} />,
        title: exposure === "internal" ? t("controlAdmin:security.flow.home") : t("controlAdmin:security.flow.internet"),
        sub: t("controlAdmin:security.flow.failed", { count: posture.failed24h })
      }}
      end={{
        icon: <LibraryBig size={24} />,
        title: t("controlAdmin:security.flow.library"),
        sub: levelCopy(scoreProtection(grades, exposure).level).word
      }}
      checks={[
        {
          question: t("controlAdmin:security.flow.proxy"),
          ...layer("proxy"),
          exit: t("controlAdmin:security.flow.proxyStops"),
          exitNote: t("controlAdmin:security.flow.proxyNote"),
          onFix: () => navigate("/help/exposing-to-the-internet")
        },
        {
          question: t("controlAdmin:security.flow.autoblock"),
          ...layer("autoblock", t("controlAdmin:security.flow.autoblockStatus", { count: blocked })),
          exit: t("controlAdmin:security.flow.autoblockStops"),
          exitNote: t("controlAdmin:security.flow.autoblockNote", { count: policy.ipFailThreshold }),
          onFix: policyAt("lockout")
        },
        {
          question: t("controlAdmin:security.flow.mfa"),
          ...layer("mfa", policy.requireMfaOutside
            ? t("controlAdmin:security.flow.mfaRequired")
            : t("controlAdmin:security.flow.mfaUsed", { count: posture.mfa.enrolled, total: posture.mfa.total })),
          exit: t("controlAdmin:security.flow.mfaStops"),
          exitNote: t("controlAdmin:security.flow.mfaNote"),
          onFix: policyAt("two-factor")
        },
        {
          question: t("controlAdmin:security.flow.alerts"),
          ...layer("alerts"),
          exit: t("controlAdmin:security.flow.alertsStops"),
          exitNote: t("controlAdmin:security.flow.alertsNote"),
          onFix: policyAt("sign-in-alerts")
        }
      ]}
    />
  );
}
