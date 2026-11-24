// Security › Overview's picture of the server's protection: four layers from the
// internet in, each wearing the grade the Policies table gives the same setting.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "../src/i18n";
import { SecurityLayers, type SecurityLayersProps } from "../src/features/control/sections/SecurityLayers";
import { gradePolicies, type GradeInput } from "../src/features/control/sections/SecurityProtection";

const input = (over: Partial<GradeInput["policy"]> = {}, more: Partial<GradeInput> = {}): GradeInput => ({
  policy: {
    lockoutThreshold: 5, lockoutMinutes: 15, ipFailThreshold: 20, ipFailWindowMinutes: 10, ipAutoblockMinutes: 60,
    alertNewIpSignIn: false, deviceLinkScope: "local", requireMfaOutside: false, hasAbuseIpdbKey: false,
    reputationAutoEscalate: false, reputationEscalateThreshold: 75, trustedDeletesOnly: false, ...over
  },
  proxy: { trustProxyHops: 0, trustProxyAddresses: [], configured: false, forwardedHeaderSeen: false },
  passwordPolicy: { minLength: 8, requireComplexity: true },
  mailConfigured: true,
  trustedNetworkCount: 1,
  ...more
});

const layers = (graded: GradeInput, over: Partial<SecurityLayersProps> = {}) => {
  render(
    <SecurityLayers
      grades={gradePolicies(graded)}
      exposure="internet"
      policy={graded.policy}
      posture={{ failed24h: 3, blocked: { live: 1, permanent: 1 }, mfa: { enrolled: 1, total: 4 } }}
      {...over}
    />
  );
  return (name: string) => screen.getByText(name).closest("li")!;
};

describe("SecurityLayers", () => {
  it("draws the four layers from the internet in", () => {
    layers(input());
    const names = screen.getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent);
    expect(names).toEqual(["Internet", "Proxy", "IP auto-block", "Two-factor", "Alerts", "Your library"]);
    expect(screen.getByText("3 failed sign-ins in 24 h")).toBeInTheDocument();
  });

  it("gives each layer its setting, its grade and what it stops", () => {
    const layer = layers(input());
    expect(layer("Proxy")).toHaveClass("is-plain");
    expect(layer("Proxy")).toHaveTextContent("Direct connection");
    expect(layer("Proxy")).toHaveTextContent("Medium");
    expect(layer("IP auto-block")).toHaveClass("is-ok");
    expect(layer("IP auto-block")).toHaveTextContent("2 addresses blocked");
    expect(layer("IP auto-block")).toHaveTextContent("Strong");
    expect(layer("IP auto-block")).toHaveTextContent("Password guessing");
    expect(layer("Two-factor")).toHaveTextContent("1 of 4 members use it");
    expect(layer("Alerts")).toHaveClass("is-warn");
    expect(layer("Alerts")).toHaveTextContent("Weak");
  });

  it("turns amber for a setting that is on but cannot work", () => {
    const layer = layers(input({ alertNewIpSignIn: true, requireMfaOutside: true }, { mailConfigured: false }));
    expect(layer("Alerts")).toHaveClass("is-warn");
    expect(layer("Two-factor")).toHaveClass("is-warn");
    expect(layer("Two-factor")).toHaveTextContent("Required from outside");
  });

  it("leaves a home-only server's waived layers plain", () => {
    const layer = layers(input(), { exposure: "internal" });
    expect(screen.getByText("Home network")).toBeInTheDocument();
    expect(layer("Proxy")).toHaveClass("is-plain");
    expect(layer("Proxy")).toHaveTextContent("Not needed at home");
    expect(layer("Two-factor")).toHaveTextContent("Not needed at home");
    // Alerts still count half at home, so the grade stays.
    expect(layer("Alerts")).toHaveClass("is-warn");
  });
});
