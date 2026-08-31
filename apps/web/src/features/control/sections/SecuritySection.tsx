import { Fragment, useState, useEffect, useCallback, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import i18n from "../../../i18n";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  CircleOff,
  ExternalLink,
  KeyRound,
  Globe,
  Infinity as InfinityIcon,
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
import { controlHref, navigate, type ControlSection } from "../../../router";
import { Pager } from "../../../shared/Pager";
import { signInsHref } from "./dashboard/SignInsView";
import { ProtectionCard, gradePolicies, type Exposure } from "./SecurityProtection";
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
  /** Live sessions whose address falls inside the range — what it is actually doing. */
  liveSessions: number;
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
  exposure: Exposure;
}

interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

interface SecurityPosture {
  failed24h: number;
  failedPrev24h: number;
  blocked: { live: number; permanent: number; lapsed: number };
  lockedAccounts: string[];
  mfa: { enrolled: number; total: number; adminsWithout: number };
}

interface SecurityData {
  posture: SecurityPosture;
  policy: SecurityPolicy;
  proxy: {
    trustProxyHops: number;
    trustProxyAddresses: string[];
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

const HEAD_DESCRIPTION_KEYS: Record<SecurityTab, "descOverview" | "descPolicies" | "descTrusted" | "descBlocked"> = {
  overview: "descOverview",
  policies: "descPolicies",
  trusted: "descTrusted",
  blocked: "descBlocked"
};

export function SecuritySection({ section }: { section: SecuritySectionKey }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
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
  // Blocked IPs: which kind the list shows, and where in it we are.
  const [blockFilter, setBlockFilter] = useState<"all" | "live" | "permanent" | "lapsed">("all");
  const [blockPage, setBlockPage] = useState(1);
  const [pendingClearLapsed, setPendingClearLapsed] = useState(false);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [clearingLapsed, setClearingLapsed] = useState(false);
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
      setError(err instanceof Error ? err.message : t("controlAdmin:security.loadFailed"));
    }
  }, [fetchSecurity, t]);

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
          ? t("controlAdmin:security.saveAlertsFailed")
          : scope === "mfa"
            ? t("controlAdmin:security.saveMfaFailed")
            : scope === "reputation"
              ? t("controlAdmin:security.saveRepFailed")
              : scope === "deletes"
                ? t("controlAdmin:security.saveDeletesFailed")
                : t("controlAdmin:security.saveThresholdsFailed");
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
      setPolicyError({ scope: "reputation", message: err instanceof Error ? err.message : t("controlAdmin:security.removeKeyFailed") });
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
      setPwError(err instanceof Error ? err.message : t("controlAdmin:security.savePwFailed"));
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
      setTrustedError(err instanceof Error ? err.message : t("controlAdmin:security.addTrustedFailed"));
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
      setTrustedError(err instanceof Error ? err.message : t("controlAdmin:security.removeTrustedFailed"));
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
      setBlockError(err instanceof Error ? err.message : t("controlAdmin:security.blockIpFailed"));
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
      setBlockError(err instanceof Error ? err.message : t("controlAdmin:security.unblockFailed"));
    }
  };

  const checkReputation = async (value: string) => {
    setBlockError("");
    setCheckingIp(value);
    try {
      await api(`/api/security/blocked-ips/${encodeURIComponent(value)}/reputation`, { method: "POST" });
      await load();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : t("controlAdmin:security.checkRepFailed"));
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
      setPermanentError(err instanceof Error ? err.message : t("controlAdmin:security.makePermanentFailed"));
    } finally {
      setMakingPermanent(false);
    }
  };

  const [savingExposure, setSavingExposure] = useState(false);
  const setExposure = async (next: Exposure) => {
    if (!policyForm || policyForm.exposure === next) return;
    setSavingExposure(true);
    setError("");
    try {
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify({ ...policyForm, exposure: next })
      });
      setPolicyForm(res.policy);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:security.exposureFailed"));
    } finally {
      setSavingExposure(false);
    }
  };

  const clearLapsed = async () => {
    setClearingLapsed(true);
    setBlockError("");
    try {
      await api("/api/security/blocked-ips/lapsed", { method: "DELETE" });
      setPendingClearLapsed(false);
      await fetchSecurity();
    } catch (err) {
      setBlockError(err instanceof Error ? err.message : t("controlAdmin:security.clearLapsedFailed"));
      setPendingClearLapsed(false);
    } finally {
      setClearingLapsed(false);
    }
  };

  // The blocked list, narrowed by the chips and cut to a page. Running blocks
  // first, then permanent, then lapsed — the order of how much they matter today.
  const BLOCK_PAGE_SIZE = 10;
  const blockKind = (entry: BlockedIp): "live" | "permanent" | "lapsed" =>
    entry.expired ? "lapsed" : entry.expiresAt === null ? "permanent" : "live";
  const blockCounts = { live: 0, permanent: 0, lapsed: 0 };
  for (const entry of data?.blockedIps ?? []) blockCounts[blockKind(entry)] += 1;
  const blockedRows = (data?.blockedIps ?? []).filter((entry) => blockFilter === "all" || blockKind(entry) === blockFilter);
  const blockTotalPages = Math.max(1, Math.ceil(blockedRows.length / BLOCK_PAGE_SIZE));
  const blockCurrent = Math.min(blockPage, blockTotalPages);
  const blockedPage = blockedRows.slice((blockCurrent - 1) * BLOCK_PAGE_SIZE, blockCurrent * BLOCK_PAGE_SIZE);

  return (
    <>
      <ControlSectionHead
        section={section}
        icon={<ShieldCheck size={30} />}
        iconClassName="blue"
        description={t(`controlAdmin:security.${HEAD_DESCRIPTION_KEYS[activeTab]}`)}
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await fetchSecurity();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:security.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:security.loadErrorTitle")}>{error}</MessageBox>}

      {data && (
        <>
          <div className="security-tab-panels">
            <div
              className="security-tab-panel"
              id="security-panel-overview"
              hidden={activeTab !== "overview"}
            >
              {/* Where every setting stands, each row a door to the policy that
                  owns it — coloured when something needs attention. */}
              <section className="security-overview-dashboard compact-tables" aria-label={t("controlAdmin:security.overviewAria")}>
                <ProtectionCard
                  grades={gradePolicies({
                    policy: data.policy,
                    proxy: data.proxy,
                    passwordPolicy: data.passwordPolicy,
                    mailConfigured: data.mailConfigured,
                    trustedNetworkCount: data.trustedNetworks.length
                  })}
                  exposure={data.policy.exposure}
                  proxySeen={data.proxy.forwardedHeaderSeen}
                  proxyConfigured={data.proxy.configured}
                  saving={savingExposure}
                  onExposureChange={setExposure}
                />

                <div className="status-subsection">
                  <div className="status-table-title">
                    <h3>{t("controlAdmin:security.policiesHeading")}</h3>
                    <span>{t("controlAdmin:security.policiesSubtitle")}</span>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid locations-table">
                      <tbody>
                        {(() => {
                          const ROW_PRESENTATION: Record<string, { icon: typeof ShieldCheck; target: { section: ControlSection } | { href: string } }> = {
                            proxy: { icon: UserRound, target: { href: repoFileUrl("docs/users/exposing-to-the-internet.md") } },
                            lockout: { icon: LockKeyhole, target: { section: "securityPolicies" } },
                            autoblock: { icon: Globe, target: { section: "securityPolicies" } },
                            mfa: { icon: LockKeyhole, target: { section: "securityPolicies" } },
                            alerts: { icon: MailWarning, target: { section: "securityPolicies" } },
                            deletes: { icon: Trash2, target: { section: "securityPolicies" } },
                            devices: { icon: MonitorSmartphone, target: { section: "securityPolicies" } },
                            password: { icon: KeyRound, target: { section: "securityPolicies" } },
                            reputation: { icon: ShieldQuestion, target: { section: "securityPolicies" } }
                          };
                          const rows = gradePolicies({
                            policy: data.policy,
                            proxy: data.proxy,
                            passwordPolicy: data.passwordPolicy,
                            mailConfigured: data.mailConfigured,
                            trustedNetworkCount: data.trustedNetworks.length
                          }).map((grade) => ({ ...grade, ...ROW_PRESENTATION[grade.key] }));
                          return rows.map((row) => {
                            const Icon = row.icon;
                            const open = () =>
                              "section" in row.target ? navigate(controlHref(row.target.section)) : window.open(row.target.href, "_blank", "noreferrer");
                            return (
                              <tr key={row.label} className="system-pointer-row" onClick={open}>
                                <td>
                                  <span className="location-cell">
                                    <Icon size={17} aria-hidden="true" className="signins-device-icon" />
                                    <span className="datagrid-primary">
                                      <strong>{row.label}</strong>
                                      <small>{row.note}</small>
                                    </span>
                                  </span>
                                </td>
                                <td className="col-num">
                                  <span className="system-pointer-value">{row.value}</span>
                                </td>
                                <td className="security-level-cell">
                                  <span
                                    className={`rate-pill security-level rate-${
                                      row.level === "strong" ? "good" : row.level === "medium" ? "warn" : "bad"
                                    }`}
                                  >
                                    {row.level === "strong" ? t("controlAdmin:security.pillStrong") : row.level === "medium" ? t("controlAdmin:security.pillMedium") : t("controlAdmin:security.pillWeak")}
                                  </span>
                                </td>
                                <td className="locations-row-action">
                                  <Button
                                    variant="icon"
                                    aria-label={"section" in row.target ? t("controlAdmin:security.openSettingAria", { label: row.label }) : t("controlAdmin:security.readGuideAria")}
                                    title={"section" in row.target ? t("controlAdmin:security.openSetting") : t("controlAdmin:security.readGuide")}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      open();
                                    }}
                                  >
                                    {"section" in row.target ? <ChevronRight size={16} aria-hidden="true" /> : <ExternalLink size={15} aria-hidden="true" />}
                                  </Button>
                                </td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
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
                    <h2 id="policy-heading">{t("controlAdmin:security.thresholdsTitle")}</h2>
                    <p className="section-description">{t("controlAdmin:security.thresholdsDesc")}</p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "thresholds")}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">{t("controlAdmin:security.lockAfterLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.lockAfterHelp")}</span>
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
                        <span className="security-setting-label">{t("controlAdmin:security.lockoutDurationLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.lockoutDurationHelp")}</span>
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
                        <span className="security-setting-label">{t("controlAdmin:security.autoblockAfterLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.autoblockAfterHelp")}</span>
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
                        <span className="security-setting-label">{t("controlAdmin:security.failWindowLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.failWindowHelp")}</span>
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
                        <span className="security-setting-label">{t("controlAdmin:security.autoblockDurationLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.autoblockDurationHelp")}</span>
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
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "thresholds" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.thresholdsSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "thresholds" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveThresholds")}
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
                    <h2 id="mfa-outside-heading">{t("controlAdmin:security.mfaTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.mfaDesc")}
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
                          {t("controlAdmin:security.mfaLabel")}
                        </span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.mfaHelp")}
                        </span>
                      </span>
                    </label>

                    {policyForm.requireMfaOutside && !data.mailConfigured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noMailTitle")}>
                        {t("controlAdmin:security.mfaNoMailBody")}
                      </MessageBox>
                    )}

                    {policyForm.requireMfaOutside && data.usersWithoutMfa.length > 0 && (
                      <MessageBox tone="info" title={t("controlAdmin:security.usersWithoutTitle")}>
                        {data.mailConfigured
                          ? t("controlAdmin:security.usersWithoutMail", { count: data.usersWithoutMfa.length, list: data.usersWithoutMfa.join(", ") })
                          : t("controlAdmin:security.usersWithoutNoMail", { count: data.usersWithoutMfa.length, list: data.usersWithoutMfa.join(", ") })}
                      </MessageBox>
                    )}

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.proxyAsksTitle")}>
                        <Trans i18nKey="security.proxyAsksBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    {policyError?.scope === "mfa" && (
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "mfa" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.mfaSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "mfa" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveMfa")}
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
                    <h2 id="signin-alert-heading">{t("controlAdmin:security.alertsTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.alertsDesc")}
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
                        <span className="security-setting-label">{t("controlAdmin:security.alertsLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.alertsHelp")}
                        </span>
                      </span>
                    </label>

                    {!data.mailConfigured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noMailTitle")}>
                        {t("controlAdmin:security.alertsNoMailBody")}
                      </MessageBox>
                    )}

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.ipsInaccurateTitle")}>
                        <Trans i18nKey="security.ipsInaccurateBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    {policyError?.scope === "alerts" && (
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "alerts" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.alertsSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "alerts" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveAlerts")}
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
                    <h2 id="deletes-heading">{t("controlAdmin:security.deletesTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.deletesDesc")}
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
                        <span className="security-setting-label">{t("controlAdmin:security.deletesLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.deletesHelp")}
                        </span>
                      </span>
                    </label>
                    {policyForm.trustedDeletesOnly && data.trustedNetworks.length === 0 && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noTrustedTitle")}>
                        {t("controlAdmin:security.noTrustedBody")}
                      </MessageBox>
                    )}
                    {policyError?.scope === "deletes" && (
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "deletes" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.deletesSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "deletes" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveDeletes")}
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
                    <h2 id="device-link-heading">{t("controlAdmin:security.devicesTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.devicesDesc")}
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
                        <span className="security-setting-label">{t("controlAdmin:security.devicesLocalLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.devicesLocalHelp")}
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
                        <span className="security-setting-label">{t("controlAdmin:security.devicesAnyLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.devicesAnyHelp")}
                        </span>
                      </span>
                    </label>

                    {data.proxy.forwardedHeaderSeen && !data.proxy.configured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.linkRefusedTitle")}>
                        <Trans i18nKey="security.linkRefusedBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    {policyError?.scope === "devices" && (
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "devices" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.devicesSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "devices" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveDevices")}
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
                    <h2 id="pw-heading">{t("controlAdmin:security.pwTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.pwDesc")}
                    </p>
                  </div>
                </div>
                {pwForm && (
                  <form className="security-policy-form" onSubmit={savePwPolicy}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">{t("controlAdmin:security.pwMinLabel")}</span>
                        <span className="security-setting-help">{t("controlAdmin:security.pwMinHelp")}</span>
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
                          {t("controlAdmin:security.pwMixLabel")}
                        </span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.pwMixHelp")}
                        </span>
                      </span>
                    </label>
                    {pwError && <MessageBox tone="error" title={t("errors.unableToSave")}>{pwError}</MessageBox>}
                    {pwSaved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.pwSaved")}</MessageBox>}
                    <div className="security-policy-actions">
                      <Button variant="primary" className="security-save-button" type="submit" disabled={savingPw}>
                        <Save size={16} />
                        {savingPw ? t("controlAdmin:ui.saving") : t("controlAdmin:security.savePw")}
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
                    <h2 id="reputation-heading">{t("controlAdmin:security.repTitle")}</h2>
                    <p className="section-description">
                      {t("controlAdmin:security.repDesc")}
                    </p>
                  </div>
                </div>
                {policyForm && (
                  <form className="security-policy-form" onSubmit={(event) => savePolicy(event, "reputation")}>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">{t("controlAdmin:security.repKeyLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.repKeyHelp")}
                          {policyForm.hasAbuseIpdbKey && t("controlAdmin:security.repKeySavedNote")}
                        </span>
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={policyForm.hasAbuseIpdbKey ? t("controlAdmin:security.repKeyPlaceholder") : ""}
                        value={abuseKeyInput}
                        onChange={(event) => setAbuseKeyInput(event.target.value)}
                      />
                    </label>
                    {policyForm.hasAbuseIpdbKey && (
                      <div className="security-setting-row">
                        <Button type="button" variant="text" onClick={removeAbuseKey} disabled={savingPolicy !== null}>
                          {t("controlAdmin:security.removeSavedKey")}
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
                        <span className="security-setting-label">{t("controlAdmin:security.repEscalateLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.repEscalateHelp")}
                        </span>
                      </span>
                    </label>
                    <label className="security-setting-row">
                      <span className="security-setting-copy">
                        <span className="security-setting-label">{t("controlAdmin:security.repThresholdLabel")}</span>
                        <span className="security-setting-help">
                          {t("controlAdmin:security.repThresholdHelp")}
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
                      <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>
                    )}
                    {policySaved === "reputation" && (
                      <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:security.repSaved")}</MessageBox>
                    )}
                    <div className="security-policy-actions">
                      <Button
                        variant="primary"
                        className="security-save-button"
                        type="submit"
                        disabled={savingPolicy !== null}
                      >
                        <Save size={16} />
                        {savingPolicy === "reputation" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.saveRep")}
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
              <section className="security-block security-network-view compact-tables" aria-labelledby="trusted-heading">
                <div className="security-network-head">
                  <h2 id="trusted-heading">{t("controlAdmin:security.trustedHeading")}</h2>
                  <p className="section-description">
                    {t("controlAdmin:security.trustedDesc")}
                  </p>
                </div>

                <MessageBox tone="warning" title={t("controlAdmin:security.trustedCalloutTitle")} className="security-network-callout">
                  <Trans i18nKey="security.trustedCalloutBody" ns="controlAdmin" components={{ cd: <code /> }} />
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
                    {t("controlAdmin:security.addNetwork")}
                  </Button>
                </div>

                {trustedError && !trustedOpen && (
                  <MessageBox tone="error" title={t("controlAdmin:security.updateTrustedFailed")}>{trustedError}</MessageBox>
                )}

                {data.trustedNetworks.length === 0 ? (
                  <div className="security-network-empty trusted">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <ShieldCheck className="security-empty-main-icon" size={72} />
                      <Globe className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>{t("controlAdmin:security.trustedEmptyHeading")}</h3>
                      <p>
                        {t("controlAdmin:security.trustedEmptyBody")}
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>{t("controlAdmin:security.trustedEmptyNote")}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
                    <table className="datagrid trusted-table">
                      <thead>
                        <tr>
                          <th>{t("controlAdmin:security.thRange")}</th>
                          <th>{t("controlAdmin:security.thLabel")}</th>
                          <th className="col-num">{t("controlAdmin:security.thInUse")}</th>
                          <th>{t("controlAdmin:security.thAdded")}</th>
                          <th className="col-actions">{t("controlAdmin:security.thActions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.trustedNetworks.map((network) => (
                          <tr key={network.id}>
                            <td>
                              <code>{network.cidr}</code>
                            </td>
                            <td className="datagrid-muted">{network.label || "—"}</td>
                            <td className={`col-num${network.liveSessions > 0 ? "" : " datagrid-muted"}`}>
                              {network.liveSessions > 0
                                ? t("controlAdmin:ui.sessions", { count: network.liveSessions })
                                : "—"}
                            </td>
                            <td className="datagrid-muted">{formatManagedDate(network.createdAt)}</td>
                            <td className="col-actions">
                              <Button
                                variant="icon"
                                danger
                                title={t("controlAdmin:security.removeTrustedTitle")}
                                aria-label={t("controlAdmin:security.removeTrustedAria", { cidr: network.cidr })}
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
              <section className="security-block security-network-view compact-tables" aria-labelledby="blocked-heading">
                <div className="security-network-head">
                  <h2 id="blocked-heading">{t("controlAdmin:security.blockedHeading")}</h2>
                  <p className="section-description">
                    {t("controlAdmin:security.blockedDesc")}
                  </p>
                </div>

                <div className="security-list-actions">
                  {/* Counter and filter in one, like the device chips on Sign-ins:
                      running blocks matter today, permanent ones were chosen,
                      lapsed ones are history. */}
                  <div className="device-type-chips" role="group" aria-label={t("controlAdmin:security.chipsAria")}>
                    {([
                      ["live", "chipRunning"],
                      ["permanent", "chipPermanent"],
                      ["lapsed", "chipLapsed"]
                    ] as const).map(([kind, wordKey]) => (
                      <button
                        key={kind}
                        type="button"
                        className={`device-type-chip${blockFilter === kind ? " is-active" : ""}`}
                        aria-pressed={blockFilter === kind}
                        onClick={() => {
                          setBlockFilter(blockFilter === kind ? "all" : kind);
                          setBlockPage(1);
                        }}
                      >
                        <strong>{blockCounts[kind]}</strong> {t(`controlAdmin:security.${wordKey}`)}
                      </button>
                    ))}
                  </div>
                  <span className="signins-scope-spacer" />
                  {blockCounts.lapsed > 0 && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setBlockError("");
                        setPendingClearLapsed(true);
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      {t("controlAdmin:security.clearLapsed", { count: blockCounts.lapsed })}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => {
                      setBlockError("");
                      setBlockOpen(true);
                    }}
                  >
                    <Ban size={16} />
                    {t("controlAdmin:security.blockIp")}
                  </Button>
                </div>

                {blockError && !blockOpen && (
                  <MessageBox tone="error" title={t("controlAdmin:security.updateBlockedFailed")}>{blockError}</MessageBox>
                )}

                {data.blockedIps.length === 0 ? (
                  <div className="security-network-empty blocked">
                    <div className="security-network-empty-visual" aria-hidden="true">
                      <Sparkles className="security-empty-spark spark-a" size={18} />
                      <CircleOff className="security-empty-main-icon" size={72} />
                      <ShieldCheck className="security-empty-spark spark-b" size={18} />
                    </div>
                    <div className="security-network-empty-copy">
                      <h3>{t("controlAdmin:security.blockedEmptyHeading")}</h3>
                      <p>
                        {t("controlAdmin:security.blockedEmptyBody")}
                      </p>
                      <div className="security-network-empty-note">
                        <ShieldCheck size={18} aria-hidden="true" />
                        <span>{t("controlAdmin:security.blockedEmptyNote")}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="datagrid-wrap security-network-table">
                    <table className="datagrid blocked-table">
                      <thead>
                        <tr>
                          <th className="col-expand" aria-label={t("controlAdmin:security.thDetails")} />
                          <th>{t("controlAdmin:security.thAddress")}</th>
                          <th>{t("controlAdmin:security.thReason")}</th>
                          <th>{t("controlAdmin:security.thReputation")}</th>
                          <th>{t("controlAdmin:security.thExpires")}</th>
                          <th className="col-actions">{t("controlAdmin:security.thActions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {blockedPage.map((entry) => {
                          const open = expandedBlock === entry.ip;
                          const place = entry.reputation
                            ? [countryName(entry.reputation.countryCode), entry.reputation.isp].filter(Boolean).join(" · ")
                            : "";
                          return (
                            <Fragment key={entry.ip}>
                              <tr className={open ? "is-expanded" : undefined}>
                                <td className="col-expand">
                                  <Button
                                    variant="icon"
                                    aria-label={open ? t("controlAdmin:security.hideDetails") : t("controlAdmin:security.showDetails")}
                                    aria-expanded={open}
                                    onClick={() => setExpandedBlock(open ? null : entry.ip)}
                                  >
                                    {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                                  </Button>
                                </td>
                                <td>
                                  <span className="datagrid-primary">
                                    <strong><code>{entry.ip}</code></strong>
                                    <small>{entry.auto ? t("controlAdmin:security.auto") : t("controlAdmin:security.manual")}</small>
                                  </span>
                                </td>
                                <td className="datagrid-muted">{entry.reason || "—"}</td>
                                <td className="datagrid-muted">
                                  {entry.reputation ? (
                                    <span
                                      className={`reputation-score ${
                                        entry.reputation.score >= 50 ? "bad" : entry.reputation.score > 0 ? "watch" : "clean"
                                      }`}
                                    >
                                      {t("controlAdmin:security.abusePct", { score: entry.reputation.score })}
                                    </span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className="datagrid-muted">
                                  {entry.expired ? (
                                    <span className="status-badge expired">{t("controlAdmin:security.expired")}</span>
                                  ) : entry.expiresAt ? (
                                    formatManagedDate(entry.expiresAt)
                                  ) : (
                                    t("controlAdmin:ui.never")
                                  )}
                                </td>
                                <td className="col-actions">
                                  {entry.expiresAt && (
                                    <Button
                                      variant="icon"
                                      title={entry.expired ? t("controlAdmin:security.makePermanentRearm") : t("controlAdmin:security.makePermanent")}
                                      aria-label={t("controlAdmin:security.makePermanentAria", { ip: entry.ip })}
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
                                    title={entry.expired ? t("controlAdmin:security.removeExpiredBlock") : t("controlAdmin:security.unblock")}
                                    aria-label={entry.expired ? t("controlAdmin:security.removeExpiredAria", { ip: entry.ip }) : t("controlAdmin:security.unblockAria", { ip: entry.ip })}
                                    onClick={() => unblock(entry.ip)}
                                  >
                                    <Trash2 size={15} />
                                  </Button>
                                  <Button
                                    variant="icon"
                                    title={t("controlAdmin:security.signInsFromTitle")}
                                    aria-label={t("controlAdmin:security.signInsFromAria", { ip: entry.ip })}
                                    onClick={() => navigate(signInsHref({ ip: entry.ip }))}
                                  >
                                    <ChevronRight size={16} aria-hidden="true" />
                                  </Button>
                                </td>
                              </tr>
                              {open && (
                                <tr className="login-detail-row">
                                  <td colSpan={6}>
                                    {/* The whole record, in the grid the Logins and
                                        Logs tables open their rows into. */}
                                    <dl className="login-detail-grid">
                                      <div>
                                        <dt>{t("controlAdmin:security.dtAddress")}</dt>
                                        <dd><code>{entry.ip}</code></dd>
                                      </div>
                                      <div>
                                        <dt>{t("controlAdmin:security.dtKind")}</dt>
                                        <dd>{entry.auto ? t("controlAdmin:security.kindAuto") : t("controlAdmin:security.kindManual")}</dd>
                                      </div>
                                      <div>
                                        <dt>{t("controlAdmin:security.dtBlocked")}</dt>
                                        <dd>{formatManagedDate(entry.createdAt)}</dd>
                                      </div>
                                      <div>
                                        <dt>{entry.expired ? t("controlAdmin:security.dtExpired") : t("controlAdmin:security.dtExpires")}</dt>
                                        <dd>{entry.expiresAt ? formatManagedDate(entry.expiresAt) : t("controlAdmin:security.neverStays")}</dd>
                                      </div>
                                      <div className="login-detail-wide">
                                        <dt>{t("controlAdmin:security.dtReason")}</dt>
                                        <dd>{entry.reason || "—"}</dd>
                                      </div>
                                      <div className="login-detail-wide">
                                        <dt>{t("controlAdmin:security.dtReputation")}</dt>
                                        <dd>
                                          {entry.reputation ? (
                                            <>
                                              {[
                                                t("controlAdmin:security.repConfidence", { score: entry.reputation.score }),
                                                entry.reputation.totalReports ? t("controlAdmin:security.repReports", { count: entry.reputation.totalReports }) : null,
                                                place || null,
                                                entry.reputation.lastReportedAt ? t("controlAdmin:security.lastReported", { date: formatManagedDate(entry.reputation.lastReportedAt) }) : null,
                                                t("controlAdmin:security.checkedAt", { date: formatManagedDate(entry.reputation.checkedAt) })
                                              ]
                                                .filter(Boolean)
                                                .join(" · ")}{" "}
                                              {data.policy.hasAbuseIpdbKey && (
                                                <Button
                                                  variant="text"
                                                  compact
                                                  disabled={checkingIp === entry.ip}
                                                  onClick={() => checkReputation(entry.ip)}
                                                >
                                                  {checkingIp === entry.ip ? t("controlAdmin:security.checking") : t("controlAdmin:security.checkAgain")}
                                                </Button>
                                              )}
                                            </>
                                          ) : data.policy.hasAbuseIpdbKey ? (
                                            <>
                                              {t("controlAdmin:security.notCheckedYet")}{" "}
                                              <Button
                                                variant="text"
                                                compact
                                                disabled={checkingIp === entry.ip}
                                                onClick={() => checkReputation(entry.ip)}
                                              >
                                                {checkingIp === entry.ip ? t("controlAdmin:security.checking") : t("controlAdmin:security.checkWith")}
                                              </Button>
                                            </>
                                          ) : (
                                            t("controlAdmin:security.addKeyHint")
                                          )}
                                        </dd>
                                      </div>
                                    </dl>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                    {blockedRows.length === 0 && (
                      <p className="status-empty">
                        {blockFilter === "live"
                          ? t("controlAdmin:security.noBlocksLive")
                          : blockFilter === "permanent"
                            ? t("controlAdmin:security.noBlocksPermanent")
                            : t("controlAdmin:security.noBlocksLapsed")}
                      </p>
                    )}
                  </div>
                )}
                {data.blockedIps.length > 0 && (
                  <Pager page={blockCurrent} totalPages={blockTotalPages} onChange={setBlockPage} label={t("controlAdmin:security.blockedPagerLabel")} />
                )}
              </section>
            </div>
          </div>

          {pendingClearLapsed && (
            <ConfirmDialog
              title={t("controlAdmin:security.clearLapsedTitle", { count: blockCounts.lapsed })}
              confirmLabel={t("controlAdmin:security.clearLapsedConfirm")}
              busyLabel={t("controlAdmin:security.clearing")}
              confirmIcon={<Trash2 size={16} />}
              busy={clearingLapsed}
              onConfirm={clearLapsed}
              onCancel={() => setPendingClearLapsed(false)}
            >
              {t("controlAdmin:security.clearLapsedBody")}
            </ConfirmDialog>
          )}

          {permanentTarget && (
            <ConfirmDialog
              title={t("controlAdmin:security.permanentTitle", { ip: permanentTarget.ip })}
              confirmLabel={t("controlAdmin:security.permanentConfirm")}
              busyLabel={t("controlAdmin:security.blocking")}
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
                ? t("controlAdmin:security.permanentBodyExpired")
                : t("controlAdmin:security.permanentBodyActive", { date: formatManagedDate(permanentTarget.expiresAt!) })}
            </ConfirmDialog>
          )}

          {trustedOpen && (
            <Modal
              variant="card"
              title={t("controlAdmin:security.addTrustedTitle")}
              icon={<Plus size={22} />}
              className="security-form-modal"
              busy={addingTrusted}
              onClose={closeTrustedModal}
              onSubmit={addTrusted}
            >
              <Field label={t("controlAdmin:security.cidrLabel")} value={cidr} onChange={setCidr} placeholder="192.168.1.0/24" />
              <Field
                label={t("controlAdmin:security.labelOptional")}
                value={label}
                onChange={setLabel}
                placeholder={t("controlAdmin:security.labelPlaceholder")}
                required={false}
              />
              {trustedError && <MessageBox tone="error" title={t("controlAdmin:security.addFailedTitle")}>{trustedError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeTrustedModal} disabled={addingTrusted} autoFocus>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" type="submit" disabled={addingTrusted || !cidr.trim()}>
                  <Plus size={16} />
                  {addingTrusted ? t("controlAdmin:security.adding") : t("controlAdmin:security.addNetwork")}
                </Button>
              </div>
            </Modal>
          )}

          {blockOpen && (
            <Modal
              variant="card"
              title={t("controlAdmin:security.blockModalTitle")}
              icon={<Ban size={22} />}
              className="security-form-modal"
              busy={blocking}
              onClose={closeBlockModal}
              onSubmit={addBlock}
            >
              <Field label={t("controlAdmin:security.ipLabel")} value={ip} onChange={setIp} placeholder="203.0.113.10" />
              <Field
                label={t("controlAdmin:security.reasonLabel")}
                value={reason}
                onChange={setReason}
                placeholder={t("controlAdmin:security.reasonPlaceholder")}
                required={false}
              />
              {blockError && <MessageBox tone="error" title={t("controlAdmin:security.blockFailedTitle")}>{blockError}</MessageBox>}
              <div className="modal-actions">
                <Button variant="secondary" onClick={closeBlockModal} disabled={blocking} autoFocus>
                  {t("common.cancel")}
                </Button>
                <Button variant="danger" type="submit" disabled={blocking || !ip.trim()}>
                  <Ban size={16} />
                  {blocking ? t("controlAdmin:security.blocking") : t("controlAdmin:security.blockIp")}
                </Button>
              </div>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
