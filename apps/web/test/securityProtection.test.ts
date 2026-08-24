import { describe, expect, it } from "vitest";
import { gradePolicies, scoreProtection, type GradeInput } from "../src/features/control/sections/SecurityProtection";

// Everything strong except the password, which is length-only — the setup
// from the screenshot that started this: it scored 94 on the internet and 88
// at home, because the home exam simply dropped four questions and the same
// shortfall became a bigger share of a smaller total.
const strongInput: GradeInput = {
  policy: {
    lockoutThreshold: 5,
    lockoutMinutes: 30,
    ipFailThreshold: 20,
    ipFailWindowMinutes: 15,
    ipAutoblockMinutes: 60,
    alertNewIpSignIn: true,
    deviceLinkScope: "local",
    requireMfaOutside: true,
    hasAbuseIpdbKey: true,
    reputationAutoEscalate: true,
    reputationEscalateThreshold: 90,
    trustedDeletesOnly: true
  },
  proxy: { trustProxyHops: 1, trustProxyAddresses: [], configured: true, forwardedHeaderSeen: true },
  passwordPolicy: { minLength: 8, requireComplexity: false },
  mailConfigured: true,
  trustedNetworkCount: 1
};

describe("protection score", () => {
  it("grades the same settings the same at home and on the internet when nothing waived differs", () => {
    const grades = gradePolicies(strongInput);
    const home = scoreProtection(grades, "internal");
    const internet = scoreProtection(grades, "internet");
    expect(internet.score).toBe(94);
    expect(home.score).toBe(94);
    // The waived rows are still counted as active, so the counters agree too.
    expect(home.counts).toEqual(internet.counts);
    expect(home.waived.map((grade) => grade.key)).toEqual(["proxy", "mfa", "deletes", "reputation"]);
    expect(internet.waived).toEqual([]);
  });

  it("never scores a home-only server lower than an internet-facing one on the same settings", () => {
    const variants: GradeInput[] = [
      strongInput,
      { ...strongInput, policy: { ...strongInput.policy, alertNewIpSignIn: false } },
      { ...strongInput, policy: { ...strongInput.policy, requireMfaOutside: false, hasAbuseIpdbKey: false } },
      { ...strongInput, proxy: { trustProxyHops: 0, trustProxyAddresses: [], configured: false, forwardedHeaderSeen: true } },
      { ...strongInput, passwordPolicy: { minLength: 6, requireComplexity: false }, mailConfigured: false },
      {
        ...strongInput,
        policy: {
          ...strongInput.policy,
          lockoutThreshold: 50,
          ipFailThreshold: 100,
          alertNewIpSignIn: false,
          deviceLinkScope: "any",
          requireMfaOutside: false,
          hasAbuseIpdbKey: false,
          trustedDeletesOnly: false
        },
        proxy: { trustProxyHops: 0, trustProxyAddresses: [], configured: false, forwardedHeaderSeen: false }
      }
    ];
    for (const input of variants) {
      const grades = gradePolicies(input);
      expect(scoreProtection(grades, "internal").score).toBeGreaterThanOrEqual(scoreProtection(grades, "internet").score);
    }
  });

  it("is gentler at home on a half-waived setting", () => {
    const grades = gradePolicies({ ...strongInput, policy: { ...strongInput.policy, alertNewIpSignIn: false } });
    expect(scoreProtection(grades, "internet")).toMatchObject({ score: 78, level: "good" });
    expect(scoreProtection(grades, "internal")).toMatchObject({ score: 86, level: "strong" });
  });
});
