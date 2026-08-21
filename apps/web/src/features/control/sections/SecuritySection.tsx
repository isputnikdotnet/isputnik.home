import { useState, useEffect, useCallback, type FormEvent } from "react";
import {
  AlertTriangle,
  Ban,
  CircleOff,
  Globe,
  Infinity as InfinityIcon,
  Info,
  LockKeyhole,
  MailWarning,
  MonitorSmartphone,
  Plus,
  Save,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Trash2,
  UserRound
} from "lucide-react";
import { api } from "../../../api";
import type { ControlSection } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { RefreshButton } from "../../../shared/RefreshButton";
import { repoFileUrl } from "../../../shared/links";
import { countryName, formatManagedDate } from "../../../shared/utils";

interface TrustedNetwork {
  id: string;
  cidr: string;
  label: string | null;
  createdAt: string;
}

interface IpReputationInfo {
  score: number;
  totalReports: number | null;
  lastReportedAt: string | null;
  countryCode: string | null;
  isp: string | null;
  checkedAt: string;
}

interface BlockedIp {
  ip: string;
  reason: string | null;
  auto: boolean;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  reputation: IpReputationInfo | null;
}

interface SecurityPolicy {
  lockoutThreshold: number;
  lockoutMinutes: number;
  ipFailThreshold: number;
  ipFailWindowMinutes: number;
  ipAutoblockMinutes: number;
  alertNewIpSignIn: boolean;
  // Where a device may ask to be linked from. No control for it on this page yet;
  // it is here because both policy cards PATCH the whole blob, and a field missing
  // from the type is a field a later edit drops on the floor.
  deviceLinkScope: "local" | "any";
  requireMfaOutside: boolean;
  // The key itself never leaves the server; the form gets only whether one is
  // stored, and sends a replacement (blank = keep) — like the SMTP password.
  hasAbuseIpdbKey: boolean;
  reputationAutoEscalate: boolean;
  reputationEscalateThreshold: number;
  trustedDeletesOnly: boolean;
}

interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

interface SecurityData {
  policy: SecurityPolicy;
  proxy: {
    trustProxyHops: number;
    configured: boolean;
    forwardedHeaderSeen: boolean;
  };
  passwordPolicy: PasswordPolicy;
  mailConfigured: boolean;
  usersWithoutMfa: string[];
  trustedNetworks: TrustedNetwork[];
  blockedIps: BlockedIp[];
}

type SecurityTab = "overview" | "policies" | "trusted" | "blocked";
type PolicyScope = "thresholds" | "alerts" | "mfa" | "devices" | "reputation" | "deletes";

type SecuritySectionKey = Extract<ControlSection, "security" | "securityPolicies" | "securityTrusted" | "securityBlocked">;

// The four panels used to be in-page state with no URL of their own, so a
// trusted network or a lockout threshold could not be linked to. They are
// Security's tab row now, driven by the route.
const TAB_FOR_SECTION: Record<SecuritySectionKey, SecurityTab> = {
  security: "overview",
  securityPolicies: "policies",
  securityTrusted: "trusted",
  securityBlocked: "blocked"
};

const HEAD_DESCRIPTION: Record<SecurityTab, string> = {
  overview: "How sign-in protection is currently set up.",
  policies: "Lockout, IP auto-blocking, password rules and sign-in alerts.",
  trusted: "Networks that skip the IP auto-block, such as your own LAN.",
  blocked: "Addresses that cannot reach the sign-in screen."
};

export function SecuritySection({ section }: { section: SecuritySectionKey }) {
  const [data, setData] = useState<SecurityData | null>(null);
  const [error, setError] = useState("");
  const activeTab = TAB_FOR_SECTION[section];

  const [policyForm, setPolicyForm] = useState<SecurityPolicy | null>(null);
  // The AbuseIPDB key input is separate from policyForm: the server never sends
  // the key back (only hasAbuseIpdbKey), so this holds a replacement to send, and
  // blank means "keep the stored one".
  const [abuseKeyInput, setAbuseKeyInput] = useState("");
  // Both policy cards write the same blob, so each tracks its own busy/result flags.
  const [savingPolicy, setSavingPolicy] = useState<PolicyScope | null>(null);
  const [policyError, setPolicyError] = useState<{ scope: PolicyScope; message: string } | null>(null);
  const [policySaved, setPolicySaved] = useState<PolicyScope | null>(null);

  const [pwForm, setPwForm] = useState<PasswordPolicy | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSaved, setPwSaved] = useState(false);

  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [addingTrusted, setAddingTrusted] = useState(false);
  const [trustedOpen, setTrustedOpen] = useState(false);
  const [trustedError, setTrustedError] = useState("");

  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockError, setBlockError] = useState("");
  const [permanentTarget, setPermanentTarget] = useState<BlockedIp | null>(null);
  const [makingPermanent, setMakingPermanent] = useState(false);
  const [permanentError, setPermanentError] = useState("");
  const [checkingIp, setCheckingIp] = useState<string | null>(null);

  // Throws on failure — the Refresh button needs to know, so it can skip its
  // "Updated" tick. Half-typed policy edits survive a reload (`prev ?? fresh`).
  const fetchSecurity = useCallback(async () => {
    const fresh = await api<SecurityData>("/api/security");
    setData(fresh);
    setPolicyForm((prev) => prev ?? { ...fresh.policy });
    setPwForm((prev) => prev ?? { ...fresh.passwordPolicy });
  }, []);

  // The fire-and-forget wrapper the page's own reloads use.
  const load = useCallback(async () => {
    try {
      await fetchSecurity();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load security settings");
    }
  }, [fetchSecurity]);

  useEffect(() => {
    load();
  }, [load]);

  const savePolicy = async (event: FormEvent, scope: PolicyScope) => {
    event.preventDefault();
    if (!policyForm) return;
    setSavingPolicy(scope);
    setPolicyError(null);
    setPolicySaved(null);
    try {
      // Send a new key only from the reputation card, and only when one was
      // typed; every other card omits it so a threshold save can't wipe it
      // (the server reads blank/absent as "keep the stored key").
      const body =
        scope === "reputation" && abuseKeyInput.trim()
          ? { ...policyForm, abuseIpdbKey: abuseKeyInput.trim() }
          : policyForm;
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      setPolicyForm(res.policy);
      if (scope === "reputation") setAbuseKeyInput("");
      setPolicySaved(scope);
      await load();
    } catch (err) {
      const fallback =
        scope === "alerts"
          ? "Unable to save alert settings"
          : scope === "mfa"
            ? "Unable to save two-factor sign-in"
            : scope === "reputation"
              ? "Unable to save reputation settings"
              : scope === "deletes"
                ? "Unable to save deletion protection"
                : "Unable to save thresholds";
      setPolicyError({ scope, message: err instanceof Error ? err.message : fallback });
    } finally {
      setSavingPolicy(null);
    }
  };

  // Blank means "keep the stored key", so removing it needs its own explicit call.
  const removeAbuseKey = async () => {
    if (!policyForm) return;
    setSavingPolicy("reputation");
    setPolicyError(null);
    setPolicySaved(null);
    try {
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify({ ...policyForm, clearAbuseIpdbKey: true })
      });
      setPolicyForm(res.policy);
      setAbuseKeyInput("");
      setPolicySaved("reputation");
      await load();
    } catch (err) {
      setPolicyError({ scope: "reputation", message: err instanceof Error ? err.message : "Unable to remove the key" });
    } finally {
      setSavingPolicy(null);
    }
  };

  const savePwPolicy = async (event: FormEvent) => {
    event.preventDefault();
    if (!pwForm) return;
    setSavingPw(true);
    setPwError("");
    setPwSaved(false);
    try {
      const res = await api<{ passwordPolicy: PasswordPolicy }>("/api/security/password-policy", {
        method: "PATCH",
        body: JSON.stringify(pwForm)
      });
      setPwForm(res.passwordPolicy);
      setPwSaved(true);
      await load();
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Unable to save password policy");
    } finally {
      setSavingPw(false);
    }
  };

  const closeTrustedModal = () => {
    setTrustedOpen(false);
    setCidr("");
    setLabel("");
    setTrustedError("");
  };

  const addTrusted = async (event: FormEvent) => {
    event.preventDefault();
    setAddingTrusted(true);
    setTrustedError("");
    try {
      await api("/api/security/trusted-networks", {
        method: "POST",
        body: JSON.stringify({ cidr, label: label.trim() || undefined })
      });
      setCidr("");
      setLabel("");
      await load();
      setTrustedOpen(false);
    } catch (err) {
      setTrustedError(err instanceof Error ? err.message : "Unable to add network");
    } finally {
      setAddingTrusted(false);
    }
  };

  const removeTrusted = async (id: string) => {
    setTrustedError("");
    try {
      await api(`/api/security/trusted-networks/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setTrustedError(err instanceof Error ? err.message : "Unable to remove network");
    }
  };

  const closeBlockModal = () => {
    setBlockOpen(false);
    setIp("");
    setReason("");
    setBlockError("");
  };

  const addBlock = async (event: FormEvent) => {
    event.preventDefault();
    setBlocking(true);
    setBlockError("");
    try {
      await api("/api/security/blocked-ips", {
        method: "POST",
        body: JSON.stringify({ ip, reason: reason.trim() || undefined })
      });
      setIp("");
      setReason("");
      await load();
      setBlockOpen(false);
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : "Unable to block IP");
    } finally {
      setBlocking(false);
    }
  };

  const unblock = async (value: string) => {
    setBlockError("");
    try {
      await api(`/api/security/blocked-ips/${encodeURIComponent(value)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : "Unable to unblock IP");
    }
  };

  const checkReputation = async (value: string) => {
    setBlockError("");
    setCheckingIp(value);
    try {
      await api(`/api/security/blocked-ips/${encodeURIComponent(value)}/reputation`, { method: "POST" });
      await load();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : "Unable to check reputation");
    } finally {
      setCheckingIp(null);
    }
  };

  const makePermanent = async () => {
    if (!permanentTarget) return;
    setMakingPermanent(true);
    setPermanentError("");
    try {
      await api(`/api/security/blocked-ips/${encodeURIComponent(permanentTarget.ip)}/permanent`, { method: "POST" });
      await load();
      setPermanentTarget(null);
    } catch (err) {
      // Keep the dialog open — the error renders inside it, next to Cancel.
      setPermanentError(err instanceof Error ? err.message : "Unable to make the block permanent");
    } finally {
      setMakingPermanent(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section={section}
        icon={<ShieldCheck size={30} />}
        iconClassName="blue"
        description={HEAD_DESCRIPTION[activeTab]}
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await fetchSecurity();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Unable to refresh security settings");
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}

      {data && (
        <>
          <div className="security-tab-panels">
            <div
              className="security-tab-panel"
              id="security-panel-overview"
              hidden={activeTab !== "overview"}
            >
              <section className="security-overview-dashboard" aria-label="Security overview">
                <div className="security-overview-cards">
                  <article className="security-overview-card">
                    <span
                      className={`security-overview-card-icon ${
                        data.proxy.forwardedHeaderSeen && !data.proxy.configured
                          ? "warning"
                          : data.proxy.configured
                            ? "success"
                            : "info"
                      }`}
                      aria-hidden="true"
                    >
                      <UserRound size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">IP mode</span>
                      <strong>
                        {data.proxy.forwardedHeaderSeen && !data.proxy.configured
                          ? "Proxy attention"
                          : data.proxy.configured
                            ? "Proxy trust configured"
                            : "Direct IP"}
                      </strong>
                      <span>
                        {data.proxy.configured
                          ? `${data.proxy.trustProxyHops} proxy hop${data.proxy.trustProxyHops === 1 ? "" : "s"} trusted`
                          : "Proxy hops not set"}
                      </span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon info" aria-hidden="true">
                      <LockKeyhole size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Lockout</span>
                      <strong>{data.policy.lockoutMinutes} min</strong>
                      <span>{data.policy.lockoutThreshold} failed attempts</span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon info" aria-hidden="true">
                      <Globe size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">IP auto-block</span>
                      <strong>{data.policy.ipAutoblockMinutes} min</strong>
                      <span>{data.policy.ipFailThreshold} failed in {data.policy.ipFailWindowMinutes} min</span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span
                      className={`security-overview-card-icon ${
                        data.policy.alertNewIpSignIn && !data.mailConfigured ? "warning" : "info"
                      }`}
                      aria-hidden="true"
                    >
                      <MailWarning size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Sign-in alerts</span>
                      <strong>{data.policy.alertNewIpSignIn ? "On" : "Off"}</strong>
                      <span>
                        {!data.policy.alertNewIpSignIn
                          ? "New networks are not emailed"
                          : data.mailConfigured
                            ? "Emailed on a new network"
                            : "SMTP not configured"}
                      </span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span
                      className={`security-overview-card-icon ${
                        data.policy.requireMfaOutside && !data.mailConfigured ? "warning" : "info"
                      }`}
                      aria-hidden="true"
                    >
                      <LockKeyhole size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Two-factor outside</span>
                      <strong>{data.policy.requireMfaOutside ? "Required" : "Optional"}</strong>
                      <span>
                        {!data.policy.requireMfaOutside
                          ? "Per-account enrollment only"
                          : data.mailConfigured
                            ? "Email fallback for the un-enrolled"
                            : "SMTP not configured"}
                      </span>
                    </div>
                  </article>

                  <article className="security-overview-card">
                    <span className="security-overview-card-icon success" aria-hidden="true">
                      <ShieldCheck size={26} />
                    </span>
                    <div className="security-overview-card-copy">
                      <span className="security-overview-card-label">Status</span>
                      <strong className="security-overview-success">Protected</strong>
                      <span>Automatic protection on</span>
                    </div>
                  </article>
                </div>

                <section
                  className={`security-dashboard-message ${
                    data.proxy.forwardedHeaderSeen && !data.proxy.configured
                      ? "warning"
                      : data.proxy.configured
                        ? "success"
                        : "info"
                  }`}
                  aria-labelledby="proxy-status-heading"
                >
                  <span className="security-dashboard-message-icon" aria-hidden="true">
                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured ? (
                      <AlertTriangle size={26} />
                    ) : data.proxy.configured ? (
                      <ShieldCheck size={26} />
                    ) : (
                      <Info size={26} />
                    )}
                  </span>
                  <div>
                    <h2 id="proxy-status-heading">
                      {data.proxy.forwardedHeaderSeen && !data.proxy.configured
                        ? "Proxy trust needs attention"
                        : data.proxy.configured
                          ? "Proxy trust is configured"
                          : "Using direct connection IPs"}
                    </h2>
                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured ? (
                      <p>
                        Requests include <code>X-Forwarded-For</code>, but <code>TRUST_PROXY_HOPS</code> is not set.
                        Every visitor may look like the proxy IP, which can break rate limits and trusted networks.
                      </p>
                    ) : data.proxy.configured ? (
                      <p>
                        Trusting {data.proxy.trustProxyHops} proxy hop{data.proxy.trustProxyHops === 1 ? "" : "s"}{" "}
                        before reading the forwarded client IP.
                      </p>
                    ) : (
                      <>
                        <p>
                          <code>TRUST_PROXY_HOPS</code> is not set, so security checks use the direct connection IP.
                          This is fine when the app is not behind a proxy.
                        </p>
                        <p className="security-help-link">
                          <a
                            href={repoFileUrl("docs/users/exposing-to-the-internet.md")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Read the exposing-to-the-internet guide
                          </a>
                        </p>
                      </>
                    )}
                  </div>
                </section>

                <section className="security-dashboard-message success" aria-labelledby="protection-status-heading">
                  <span className="security-dashboard-message-icon" aria-hidden="true">
                    <ShieldCheck size={26} />
                  </span>
                  <div>
                    <h2 id="protection-status-heading">Automatic protection is on</h2>
                    <p>
                      Accounts lock for {data.policy.lockoutMinutes} minutes after {data.policy.lockoutThreshold}{" "}
                      failed sign-ins.
                    </p>
                    <p>
                      An IP is auto-blocked for {data.policy.ipAutoblockMinutes} minutes after{" "}
                      {data.policy.ipFailThreshold} failed sign-ins within {data.policy.ipFailWindowMinutes} minutes.
                    </p>
                  </div>
                </section>
              </section>
            </div>

            <div
              className="security-tab-panel"
              id="security-panel-policies"
              hidden={activeTab !== "policies"}
            >
              <section className="security-block security-policy-card" aria-labelledby="policy-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <ShieldCheck size={24} />
                  </span>
                  <div>
                    <h2 id="policy-heading">Protection thresholds</h2>
                    <p className="section-description">Tune the lockout and IP auto-block. Changes apply immediately.</p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "thresholds")}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Lock account after (failed sign-ins)</span>
                        <span className="security-setting-help">Number of consecutive failed sign-in attempts.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.lockoutThreshold}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, lockoutThreshold: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Lockout duration (minutes)</span>
                        <span className="security-setting-help">Time the account remains locked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.lockoutMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, lockoutMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Auto-block IP after (failed sign-ins)</span>
                        <span className="security-setting-help">Number of failed sign-ins before an IP is blocked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipFailThreshold}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipFailThreshold: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">IP failure window (minutes)</span>
                        <span className="security-setting-help">Time window to count failed sign-ins from the same IP.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipFailWindowMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipFailWindowMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Auto-block duration (minutes)</span>
                        <span className="security-setting-help">Time the IP remains blocked.</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={policyForm.ipAutoblockMinutes}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, ipAutoblockMinutes: Number(event.target.value) })
                        }
                      />
                    </label>
                    {policyError?.scope === "thresholds" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "thresholds" && (
                      <MessageBox tone="success" title="Saved">Thresholds updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "thresholds" ? "Saving…" : "Save thresholds"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="signin-alert-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <MailWarning size={24} />
                  </span>
                  <div>
                    <h2 id="signin-alert-heading">Sign-in alerts</h2>
                    <p className="section-description">
                      Warn about a successful sign-in from somewhere the account has never been used.
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "alerts")}>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={policyForm.alertNewIpSignIn}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, alertNewIpSignIn: event.target.checked })
                        }
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Email on a sign-in from a new network</span>
                        <span className="security-setting-help">
                          The account owner and the admins are emailed. Networks are matched loosely (the /24 for
                          IPv4, the /64 for IPv6) so a changing home or mobile address doesn't alert every time.
                          Sign-ins from trusted networks never alert.
                        </span>
                      </span>
                    </label>

                    {!data.mailConfigured && (
                      <MessageBox tone="warning" title="Email is not set up">
                        These alerts are sent over SMTP. Configure it under Control panel → Settings → Email,
                        or this setting has no effect.
                      </MessageBox>
                    )}

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title="Client IPs aren't accurate yet">
                        Requests arrive through a proxy but <code>TRUST_PROXY_HOPS</code> is not set, so every visitor
                        looks like the proxy address. Until you set it, a new network is never detected.
                      </MessageBox>
                    )}

                    {policyError?.scope === "alerts" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "alerts" && (
                      <MessageBox tone="success" title="Saved">Sign-in alerts updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "alerts" ? "Saving…" : "Save sign-in alerts"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="mfa-outside-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <ShieldCheck size={24} />
                  </span>
                  <div>
                    <h2 id="mfa-outside-heading">Two-factor sign-in</h2>
                    <p className="section-description">
                      Whether a password alone is enough to sign in from outside your trusted networks.
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "mfa")}>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={policyForm.requireMfaOutside}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, requireMfaOutside: event.target.checked })
                        }
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">
                          Require a second factor outside trusted networks
                        </span>
                        <span className="security-setting-help">
                          Even a stolen or guessed password is then not enough to get in from the internet. Accounts
                          with two-factor set up use their usual method; accounts without get a one-time code emailed
                          to their sign-in address. Passkey sign-ins already count as two factors. At home — on a
                          trusted network — nothing changes.
                        </span>
                      </span>
                    </label>

                    {policyForm.requireMfaOutside && !data.mailConfigured && (
                      <MessageBox tone="warning" title="Email is not set up">
                        The emailed-code fallback needs SMTP, configured under Control panel → Settings → Email.
                        Without it, accounts that haven't set up two-factor cannot sign in from outside at all
                        until they enroll from home.
                      </MessageBox>
                    )}

                    {policyForm.requireMfaOutside && data.usersWithoutMfa.length > 0 && (
                      <MessageBox tone="info" title="Accounts without two-factor set up">
                        {data.usersWithoutMfa.join(", ")} — {data.usersWithoutMfa.length === 1 ? "this account" : "these accounts"}{" "}
                        will {data.mailConfigured ? "get a code by email when signing in from outside" : "be unable to sign in from outside until two-factor is set up or email is configured"}.
                      </MessageBox>
                    )}

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title="Every sign-in will ask for the second factor">
                        Requests arrive through a proxy but <code>TRUST_PROXY_HOPS</code> is not set, so the server
                        cannot tell who is on a trusted network. With this policy on, it plays safe and asks
                        everyone — including at home — until you set it.
                      </MessageBox>
                    )}

                    {policyError?.scope === "mfa" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "mfa" && (
                      <MessageBox tone="success" title="Saved">Two-factor sign-in updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "mfa" ? "Saving…" : "Save two-factor sign-in"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="device-link-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <MonitorSmartphone size={24} />
                  </span>
                  <div>
                    <h2 id="device-link-heading">Linking devices</h2>
                    <p className="section-description">
                      Where a TV, display or kiosk may ask to be signed in from by showing a code.
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "devices")}>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="radio"
                        name="device-link-scope"
                        checked={policyForm.deviceLinkScope === "local"}
                        onChange={() => setPolicyForm({ ...policyForm, deviceLinkScope: "local" })}
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Only devices on your home network</span>
                        <span className="security-setting-help">
                          The recommended setting. A wall display is always in the house, and this is what stops a
                          stranger elsewhere from starting a request at all.
                        </span>
                      </span>
                    </label>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="radio"
                        name="device-link-scope"
                        checked={policyForm.deviceLinkScope === "any"}
                        onChange={() => setPolicyForm({ ...policyForm, deviceLinkScope: "any" })}
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Any device that can reach the server</span>
                        <span className="security-setting-help">
                          Needed only if you link devices while away from home. It also lets someone else start a
                          request and send you its code — approving one still needs your password, so never approve a
                          device you didn't just set up, and check the code matches the screen in front of you.
                        </span>
                      </span>
                    </label>

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title="Device linking is refusing everything">
                        Requests arrive through a proxy but <code>TRUST_PROXY_HOPS</code> is not set, so every device
                        looks like it is on the proxy's own address — which would make "home network only" mean
                        "anyone at all". Linking is refused entirely until you set it.
                      </MessageBox>
                    )}

                    {policyError?.scope === "devices" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "devices" && (
                      <MessageBox tone="success" title="Saved">Device linking updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "devices" ? "Saving…" : "Save device linking"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="pw-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <LockKeyhole size={24} />
                  </span>
                  <div>
                    <h2 id="pw-heading">Password policy</h2>
                    <p className="section-description">
                      Applies when a password is set or changed. Existing passwords keep working.
                    </p>
                  </div>
                </div>
                {pwForm && (
                  <form className="security-policy-form" onSubmit={savePwPolicy}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Minimum length</span>
                        <span className="security-setting-help">Minimum number of characters.</span>
                      </span>
                      <input
                        type="number"
                        min={8}
                        max={128}
                        value={pwForm.minLength}
                        onChange={(event) => setPwForm({ ...pwForm, minLength: Number(event.target.value) })}
                      />
                    </label>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={pwForm.requireComplexity}
                        onChange={(event) => setPwForm({ ...pwForm, requireComplexity: event.target.checked })}
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">
                          Require a mix of letters, numbers, and symbols (at least 3 of 4)
                        </span>
                        <span className="security-setting-help">
                          Improve password strength by requiring character variety.
                        </span>
                      </span>
                    </label>
                    {pwError && <MessageBox tone="error" title="Unable to save">{pwError}</MessageBox>}
                    {pwSaved && <MessageBox tone="success" title="Saved">Password policy updated.</MessageBox>}
                    <div className="security-policy-actions">
                      <Button variant="primary" className="security-save-button" type="submit" disabled={savingPw}>
                        <Save size={16} />
                        {savingPw ? "Saving…" : "Save password policy"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="reputation-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <ShieldQuestion size={24} />
                  </span>
                  <div>
                    <h2 id="reputation-heading">IP reputation (AbuseIPDB)</h2>
                    <p className="section-description">
                      Look up addresses this server has already flagged against AbuseIPDB's community database, and
                      show the result next to each blocked IP.
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "reputation")}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">AbuseIPDB API key</span>
                        <span className="security-setting-help">
                          Free at abuseipdb.com. Leave empty to keep reputation lookups off — with a key set, addresses
                          that trip the auto-block (and ones you check by hand) are sent to AbuseIPDB. Only already-
                          flagged addresses are ever looked up, never regular visitors.
                          {policyForm.hasAbuseIpdbKey && " A key is saved; type a new one to replace it."}
                        </span>
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={policyForm.hasAbuseIpdbKey ? "•••••••• (saved)" : ""}
                        value={abuseKeyInput}
                        onChange={(event) => setAbuseKeyInput(event.target.value)}
                      />
                    </label>
                    {policyForm.hasAbuseIpdbKey && (
                      <div className="security-setting-row">
                        <Button type="button" variant="text" onClick={removeAbuseKey} disabled={savingPolicy !== null}>
                          Remove saved key
                        </Button>
                      </div>
                    )}
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={policyForm.reputationAutoEscalate}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, reputationAutoEscalate: event.target.checked })
                        }
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Make auto-blocks permanent for known abusive IPs</span>
                        <span className="security-setting-help">
                          When an address gets auto-blocked and AbuseIPDB reports it above the score below, the block
                          keeps no expiry instead of the usual cooldown. You can always unblock it by hand.
                        </span>
                      </span>
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Abuse confidence score to escalate at (50–100)</span>
                        <span className="security-setting-help">
                          AbuseIPDB's 0–100 confidence that an address is abusive. 90+ keeps false positives rare.
                        </span>
                      </span>
                      <input
                        type="number"
                        min={50}
                        max={100}
                        value={policyForm.reputationEscalateThreshold}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, reputationEscalateThreshold: Number(event.target.value) })
                        }
                      />
                    </label>
                    {policyError?.scope === "reputation" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "reputation" && (
                      <MessageBox tone="success" title="Saved">Reputation settings updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "reputation" ? "Saving…" : "Save reputation settings"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>

              <section className="security-block security-policy-card" aria-labelledby="deletes-heading">
                <div className="security-policy-card-head">
                  <span className="security-policy-icon" aria-hidden="true">
                    <Trash2 size={24} />
                  </span>
                  <div>
                    <h2 id="deletes-heading">Deletion protection</h2>
                    <p className="section-description">
                      Keep destructive actions to networks you trust, so stolen credentials used from the internet
                      can't destroy the library.
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "deletes")}>
                    <label className="security-setting-row security-setting-row-checkbox">
                      <input
                        type="checkbox"
                        checked={policyForm.trustedDeletesOnly}
                        onChange={(event) =>
                          setPolicyForm({ ...policyForm, trustedDeletesOnly: event.target.checked })
                        }
                      />
                      <span className="security-setting-copy">
                        <span className="security-setting-label">Allow deletions only from trusted networks</span>
                        <span className="security-setting-help">
                          Applies to every account, admins included. Away from home, everything still works — browsing,
                          uploads, edits, progress — but deleting items, emptying the Recycle Bin, cleaning up
                          duplicates, and restoring backups are refused until you're back on a trusted network.
                        </span>
                      </span>
                    </label>
                    {policyForm.trustedDeletesOnly && data.trustedNetworks.length === 0 && (
                      <MessageBox tone="warning" title="No trusted networks are defined">
                        With this on and no trusted networks, nobody can delete anything from anywhere. Add your home
                        network under Trusted networks, or turn this off.
                      </MessageBox>
                    )}
                    {policyError?.scope === "deletes" && (
                      <MessageBox tone="error" title="Unable to save">{policyError.message}</MessageBox>
                    )}
                    {policySaved === "deletes" && (
                      <MessageBox tone="success" title="Saved">Deletion protection updated.</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "deletes" ? "Saving…" : "Save deletion protection"}
                      </Button>
                    </div>
                  </form>
                )}
              </section>
            </div>

            <div
              className="security-tab-panel"
              id="security-panel-trusted"
              hidden={activeTab !== "trusted"}
            >
              <section className="security-block security-network-view" aria-labelledby="trusted-heading">
                <div className="security-network-head">
                  <h2 id="trusted-heading">Trusted networks</h2>
                  <p className="section-description">
                    Requests from these ranges skip rate limits, account lockout, and two-factor — handy on your home
                    LAN. Leave empty unless you need it.
                  </p>
                </div>

                <MessageBox tone="warning" title="Use with care" className="security-network-callout">
                  Only add ranges you fully control. If you run behind a reverse proxy, set{" "}
                  <code>TRUST_PROXY_HOPS</code> first — otherwise every visitor can look like one private IP and bypass
                  two-factor.
                </MessageBox>

                <div className="security-list-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setTrustedError("");
                      setTrustedOpen(true);
                    }}
                  >
                    <Plus size={16} />
                    Add network
                  </Button>
                </div>

                {trustedError && !trustedOpen && (
                  <MessageBox tone="error" title="Unable to update trusted networks">{trustedError}</MessageBox>
                )}

                {data.trustedNetworks.length === 0 ? (
                  <div className="security-network-empty trusted">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <ShieldCheck className="security-empty-main-icon" size={72} />
                      <Globe className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>No trusted networks yet</h3>
                      <p>
                        When you add a network range here, requests from those IPs will skip rate limits, account
                        lockout, and two-factor.
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>Two-factor and lockout apply everywhere.</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
                    <table className="datagrid">
                      <thead>
                        <tr>
                          <th>Range</th>
                          <th>Label</th>
                          <th>Added</th>
                          <th className="col-actions">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.trustedNetworks.map((network) => (
                          <tr key={network.id}>
                            <td>
                              <code>{network.cidr}</code>
                            </td>
                            <td className="datagrid-muted">{network.label || "—"}</td>
                            <td className="datagrid-muted">{formatManagedDate(network.createdAt)}</td>
                            <td className="col-actions">
                              <Button
                                variant="icon"
                                danger
                                title="Remove trusted network"
                                aria-label={`Remove ${network.cidr}`}
                                onClick={() => removeTrusted(network.id)}
                              >
                                <Trash2 size={15} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <div
              className="security-tab-panel"
              id="security-panel-blocked"
              hidden={activeTab !== "blocked"}
            >
              <section className="security-block security-network-view" aria-labelledby="blocked-heading">
                <div className="security-network-head">
                  <h2 id="blocked-heading">Blocked IPs</h2>
                  <p className="section-description">
                    Blocked addresses are refused everywhere. Automatic blocks expire on their own and are then labeled
                    Expired — remove them whenever you want to tidy the list. Manual blocks stay until you remove them.
                  </p>
                </div>

                <div className="security-list-actions">
                  <Button
                    variant="danger"
                    onClick={() => {
                      setBlockError("");
                      setBlockOpen(true);
                    }}
                  >
                    <Ban size={16} />
                    Block IP
                  </Button>
                </div>

                {blockError && !blockOpen && (
                  <MessageBox tone="error" title="Unable to update blocked IPs">{blockError}</MessageBox>
                )}

                {data.blockedIps.length === 0 ? (
                  <div className="security-network-empty blocked">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <CircleOff className="security-empty-main-icon" size={72} />
                      <ShieldCheck className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>No blocked IPs yet</h3>
                      <p>
                        Manually blocked addresses will appear here. Automatic blocks also show up while they are active.
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>No addresses are currently refused manually.</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
                    <table className="datagrid">
                      <thead>
                        <tr>
                          <th>IP</th>
                          <th>Reason</th>
                          <th>Type</th>
                          <th>Reputation</th>
                          <th>Expires</th>
                          <th className="col-actions">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.blockedIps.map((entry) => (
                          <tr key={entry.ip}>
                            <td>
                              <code>{entry.ip}</code>
                            </td>
                            <td className="datagrid-muted">{entry.reason || "—"}</td>
                            <td className="datagrid-muted">{entry.auto ? "Automatic" : "Manual"}</td>
                            <td className="datagrid-muted">
                              {entry.reputation ? (
                                <span className="reputation-cell">
                                  <span
                                    className={`reputation-score ${
                                      entry.reputation.score >= 50 ? "bad" : entry.reputation.score > 0 ? "watch" : "clean"
                                    }`}
                                  >
                                    {entry.reputation.score}% abuse confidence
                                    {entry.reputation.totalReports
                                      ? ` · ${entry.reputation.totalReports.toLocaleString()} reports`
                                      : ""}
                                  </span>
                                  {[countryName(entry.reputation.countryCode), entry.reputation.isp]
                                    .filter(Boolean)
                                    .join(" · ") && (
                                    <small>
                                      {[countryName(entry.reputation.countryCode), entry.reputation.isp]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </small>
                                  )}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="datagrid-muted">
                              {entry.expired ? (
                                <>
                                  <span className="status-badge expired">Expired</span>{" "}
                                  {formatManagedDate(entry.expiresAt!)}
                                </>
                              ) : entry.expiresAt ? (
                                formatManagedDate(entry.expiresAt)
                              ) : (
                                "Never"
                              )}
                            </td>
                            <td className="col-actions">
                              {data.policy.hasAbuseIpdbKey && (
                                <Button
                                  variant="icon"
                                  title="Check reputation"
                                  aria-label={`Check reputation of ${entry.ip}`}
                                  disabled={checkingIp === entry.ip}
                                  onClick={() => checkReputation(entry.ip)}
                                >
                                  <ShieldQuestion size={15} />
                                </Button>
                              )}
                              {entry.expiresAt && (
                                <Button
                                  variant="icon"
                                  title={entry.expired ? "Re-arm as a permanent block" : "Make permanent"}
                                  aria-label={`Make block on ${entry.ip} permanent`}
                                  onClick={() => {
                                    setPermanentError("");
                                    setPermanentTarget(entry);
                                  }}
                                >
                                  <InfinityIcon size={15} />
                                </Button>
                              )}
                              <Button
                                variant="icon"
                                title={entry.expired ? "Remove expired block" : "Unblock"}
                                aria-label={`${entry.expired ? "Remove expired block for" : "Unblock"} ${entry.ip}`}
                                onClick={() => unblock(entry.ip)}
                              >
                                <Trash2 size={15} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </div>

          {permanentTarget && (
            <ConfirmDialog
              title={`Block ${permanentTarget.ip} permanently?`}
              confirmLabel="Block permanently"
              busyLabel="Blocking…"
              confirmIcon={<InfinityIcon size={16} />}
              busy={makingPermanent}
              error={permanentError}
              onConfirm={makePermanent}
              onCancel={() => {
                setPermanentTarget(null);
                setPermanentError("");
              }}
            >
              {permanentTarget.expired
                ? "This block has already expired. Making it permanent re-arms it, and it then stays until you unblock this address."
                : `This block currently expires ${formatManagedDate(permanentTarget.expiresAt!)}. It will become a manual block that stays until you unblock this address.`}
            </ConfirmDialog>
          )}

          {trustedOpen && (
            <Modal
              variant="card"
              title="Add trusted network"
              icon={<Plus size={22} />}
              className="security-form-modal"
              busy={addingTrusted}
              onClose={closeTrustedModal}
              onSubmit={addTrusted}
            >
              <Field label="IP or CIDR range" value={cidr} onChange={setCidr} placeholder="192.168.1.0/24" />
              <Field
                label="Label (optional)"
                value={label}
                onChange={setLabel}
                placeholder="Home LAN"
                required={false}
              />
              {trustedError && <MessageBox tone="error" title="Unable to add">{trustedError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeTrustedModal} disabled={addingTrusted} autoFocus>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={addingTrusted || !cidr.trim()}>
                  <Plus size={16} />
                  {addingTrusted ? "Adding…" : "Add network"}
                </Button>
              </div>
            </Modal>
          )}

          {blockOpen && (
            <Modal
              variant="card"
              title="Block IP address"
              icon={<Ban size={22} />}
              className="security-form-modal"
              busy={blocking}
              onClose={closeBlockModal}
              onSubmit={addBlock}
            >
              <Field label="IP address" value={ip} onChange={setIp} placeholder="203.0.113.10" />
              <Field
                label="Reason (optional)"
                value={reason}
                onChange={setReason}
                placeholder="Why it's blocked"
                required={false}
              />
              {blockError && <MessageBox tone="error" title="Unable to block">{blockError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeBlockModal} disabled={blocking} autoFocus>
                  Cancel
                </Button>
                <Button variant="danger" type="submit" disabled={blocking || !ip.trim()}>
                  <Ban size={16} />
                  {blocking ? "Blocking…" : "Block IP"}
                </Button>
              </div>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
