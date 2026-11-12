import { Fragment, useState, useEffect, useCallback, type FormEvent } from "react";
import { initialParam } from "../links";
import { Trans, useTranslation } from "react-i18next";
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
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Trash2,
  UserRound
} from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, navigate, type ControlSection } from "../../../router";
import { Pager } from "../../../shared/Pager";
import { signInsHref } from "./dashboard/SignInsView";
import { ProtectionCard, gradePolicies, type Exposure } from "./SecurityProtection";
import { ControlSectionHead } from "../ControlSectionHead";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { ActionRow, CheckRow, GroupedList, InputRow, ToggleRow } from "../../../shared/GroupedList";
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
  alertAdminsDeviceLinked: boolean;
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
type PolicyNumberField = "lockoutThreshold" | "lockoutMinutes" | "ipFailThreshold" | "ipFailWindowMinutes" | "ipAutoblockMinutes" | "reputationEscalateThreshold";

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

  const [pwForm, setPwForm] = useState<PasswordPolicy | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");

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

  // Policies save as they change, like a phone's Settings (control panel v2): a
  // switch or choice the moment it moves, a number when its field is left. Every
  // card writes the same blob, so each save sends the whole form with the change
  // folded in; a failed save puts the stored value back and says why.
  const savePolicy = async (scope: PolicyScope, patch: Partial<SecurityPolicy> = {}, abuseKey?: string) => {
    if (!policyForm) return;
    const next = { ...policyForm, ...patch };
    setPolicyForm(next);
    setSavingPolicy(scope);
    setPolicyError(null);
    try {
      // Send a new key only when one was typed; every other save omits it so it
      // can't wipe it (the server reads blank/absent as "keep the stored key").
      const body = abuseKey ? { ...next, abuseIpdbKey: abuseKey } : next;
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      setPolicyForm(res.policy);
      if (abuseKey) setAbuseKeyInput("");
      await load();
    } catch (err) {
      if (data) setPolicyForm({ ...data.policy });
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

  // A number row is saved when it is left — and only when it changed. A blank or
  // out-of-range value goes back to what is stored instead of being sent.
  const commitNumber = (scope: PolicyScope, field: PolicyNumberField, min: number, max = Number.MAX_SAFE_INTEGER) => {
    if (!policyForm || !data) return;
    const value = policyForm[field];
    if (value === data.policy[field]) return;
    if (!Number.isInteger(value) || value < min || value > max) {
      setPolicyForm({ ...policyForm, [field]: data.policy[field] });
      return;
    }
    void savePolicy(scope);
  };

  // Blank means "keep the stored key", so removing it needs its own explicit call.
  const removeAbuseKey = async () => {
    if (!policyForm) return;
    setSavingPolicy("reputation");
    setPolicyError(null);
    try {
      const res = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
        method: "PATCH",
        body: JSON.stringify({ ...policyForm, clearAbuseIpdbKey: true })
      });
      setPolicyForm(res.policy);
      setAbuseKeyInput("");
      await load();
    } catch (err) {
      setPolicyError({ scope: "reputation", message: err instanceof Error ? err.message : t("controlAdmin:security.removeKeyFailed") });
    } finally {
      setSavingPolicy(null);
    }
  };

  const savePwPolicy = async (patch: Partial<PasswordPolicy> = {}) => {
    if (!pwForm) return;
    const next = { ...pwForm, ...patch };
    setPwForm(next);
    setSavingPw(true);
    setPwError("");
    try {
      const res = await api<{ passwordPolicy: PasswordPolicy }>("/api/security/password-policy", {
        method: "PATCH",
        body: JSON.stringify(next)
      });
      setPwForm(res.passwordPolicy);
      await load();
    } catch (err) {
      if (data) setPwForm({ ...data.passwordPolicy });
      setPwError(err instanceof Error ? err.message : t("controlAdmin:security.savePwFailed"));
    } finally {
      setSavingPw(false);
    }
  };

  const commitPwMin = () => {
    if (!pwForm || !data) return;
    if (pwForm.minLength === data.passwordPolicy.minLength) return;
    if (!Number.isInteger(pwForm.minLength) || pwForm.minLength < 8 || pwForm.minLength > 128) {
      setPwForm({ ...pwForm, minLength: data.passwordPolicy.minLength });
      return;
    }
    void savePwPolicy();
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

  // ?block=<address> arrives from a sign-in worth shutting out (blockIpHref): open
  // the Block dialog with the address filled in, then drop the parameter so a
  // reload or Back doesn't open it again.
  useEffect(() => {
    if (section !== "securityBlocked") return;
    const address = initialParam("block");
    if (!address) return;
    setIp(address);
    setBlockOpen(true);
    const query = new URLSearchParams(window.location.search);
    query.delete("block");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query.size ? `?${query}` : ""}`);
  }, [section]);

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
                    <table className="datagrid datagrid-phone-stack locations-table">
                      <tbody>
                        {(() => {
                          // `anchor` is the policy card's id, so the arrow lands on the
                          // card that grade is about rather than the top of Policies.
                          const ROW_PRESENTATION: Record<string, { icon: typeof ShieldCheck; target: { section: ControlSection; anchor: string } | { href: string } }> = {
                            proxy: { icon: UserRound, target: { href: repoFileUrl("docs/users/exposing-to-the-internet.md") } },
                            lockout: { icon: LockKeyhole, target: { section: "securityPolicies", anchor: "lockout" } },
                            autoblock: { icon: Globe, target: { section: "securityPolicies", anchor: "lockout" } },
                            mfa: { icon: LockKeyhole, target: { section: "securityPolicies", anchor: "two-factor" } },
                            alerts: { icon: MailWarning, target: { section: "securityPolicies", anchor: "sign-in-alerts" } },
                            deletes: { icon: Trash2, target: { section: "securityPolicies", anchor: "deletion-protection" } },
                            devices: { icon: MonitorSmartphone, target: { section: "securityPolicies", anchor: "device-linking" } },
                            password: { icon: KeyRound, target: { section: "securityPolicies", anchor: "password-policy" } },
                            reputation: { icon: ShieldQuestion, target: { section: "securityPolicies", anchor: "ip-reputation" } }
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
                              "section" in row.target ? navigate(`${controlHref(row.target.section)}#${row.target.anchor}`) : window.open(row.target.href, "_blank", "noreferrer");
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
                                <td className="col-actions locations-row-action">
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
              {policyForm && pwForm && (() => {
                const busy = savingPolicy !== null;
                const num = (field: PolicyNumberField) => (Number.isNaN(policyForm[field]) ? "" : String(policyForm[field]));
                const setNum = (field: PolicyNumberField) => (value: string) =>
                  setPolicyForm({ ...policyForm, [field]: value === "" ? Number.NaN : Number(value) });
                const errorFor = (scope: PolicyScope) =>
                  policyError?.scope === scope && <MessageBox tone="error" title={t("errors.unableToSave")}>{policyError.message}</MessageBox>;
                const emailLink = <a href={controlHref("email")} onClick={(event) => followRoute(event, controlHref("email"))} />;
                const proxyUnset = data.proxy.forwardedHeaderSeen && !data.proxy.configured;
                return (
                  <div className="grouped-page">
                    <GroupedList id="lockout" title={t("controlAdmin:security.thresholdsTitle")} note={t("controlAdmin:security.thresholdsDesc")}>
                      <InputRow
                        label={t("controlAdmin:security.lockAfterRow")}
                        sub={t("controlAdmin:security.lockAfterHelp")}
                        type="number"
                        min={1}
                        value={num("lockoutThreshold")}
                        unit={t("controlAdmin:security.unitFailures", { count: policyForm.lockoutThreshold || 0 })}
                        onChange={setNum("lockoutThreshold")}
                        onCommit={() => commitNumber("thresholds", "lockoutThreshold", 1)}
                      />
                      <InputRow
                        label={t("controlAdmin:security.lockoutDurationRow")}
                        sub={t("controlAdmin:security.lockoutDurationHelp")}
                        type="number"
                        min={1}
                        value={num("lockoutMinutes")}
                        unit={t("controlAdmin:security.unitMinutes")}
                        onChange={setNum("lockoutMinutes")}
                        onCommit={() => commitNumber("thresholds", "lockoutMinutes", 1)}
                      />
                      <InputRow
                        label={t("controlAdmin:security.autoblockAfterRow")}
                        sub={t("controlAdmin:security.autoblockAfterHelp")}
                        type="number"
                        min={1}
                        value={num("ipFailThreshold")}
                        unit={t("controlAdmin:security.unitFailures", { count: policyForm.ipFailThreshold || 0 })}
                        onChange={setNum("ipFailThreshold")}
                        onCommit={() => commitNumber("thresholds", "ipFailThreshold", 1)}
                      />
                      <InputRow
                        label={t("controlAdmin:security.failWindowRow")}
                        sub={t("controlAdmin:security.failWindowHelp")}
                        type="number"
                        min={1}
                        value={num("ipFailWindowMinutes")}
                        unit={t("controlAdmin:security.unitMinutes")}
                        onChange={setNum("ipFailWindowMinutes")}
                        onCommit={() => commitNumber("thresholds", "ipFailWindowMinutes", 1)}
                      />
                      <InputRow
                        label={t("controlAdmin:security.autoblockDurationRow")}
                        sub={t("controlAdmin:security.autoblockDurationHelp")}
                        type="number"
                        min={1}
                        value={num("ipAutoblockMinutes")}
                        unit={t("controlAdmin:security.unitMinutes")}
                        onChange={setNum("ipAutoblockMinutes")}
                        onCommit={() => commitNumber("thresholds", "ipAutoblockMinutes", 1)}
                      />
                    </GroupedList>
                    {errorFor("thresholds")}

                    <GroupedList id="two-factor" title={t("controlAdmin:security.mfaTitle")} note={t("controlAdmin:security.mfaDesc")}>
                      <ToggleRow
                        label={t("controlAdmin:security.mfaLabel")}
                        sub={t("controlAdmin:security.mfaHelp")}
                        checked={policyForm.requireMfaOutside}
                        disabled={busy}
                        onChange={(next) => void savePolicy("mfa", { requireMfaOutside: next })}
                      />
                    </GroupedList>
                    {errorFor("mfa")}
                    {policyForm.requireMfaOutside && !data.mailConfigured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noMailTitle")}>
                        <Trans i18nKey="security.mfaNoMailBody" ns="controlAdmin" components={{ lnk: emailLink }} />
                      </MessageBox>
                    )}
                    {policyForm.requireMfaOutside && data.usersWithoutMfa.length > 0 && (
                      <MessageBox tone="info" title={t("controlAdmin:security.usersWithoutTitle")}>
                        {data.mailConfigured
                          ? t("controlAdmin:security.usersWithoutMail", { count: data.usersWithoutMfa.length, list: data.usersWithoutMfa.join(", ") })
                          : t("controlAdmin:security.usersWithoutNoMail", { count: data.usersWithoutMfa.length, list: data.usersWithoutMfa.join(", ") })}
                      </MessageBox>
                    )}
                    {proxyUnset && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.proxyAsksTitle")}>
                        <Trans i18nKey="security.proxyAsksBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    <GroupedList id="sign-in-alerts" title={t("controlAdmin:security.alertsTitle")} note={t("controlAdmin:security.alertsDesc")}>
                      <ToggleRow
                        label={t("controlAdmin:security.alertsLabel")}
                        sub={t("controlAdmin:security.alertsHelp")}
                        checked={policyForm.alertNewIpSignIn}
                        disabled={busy}
                        onChange={(next) => void savePolicy("alerts", { alertNewIpSignIn: next })}
                      />
                    </GroupedList>
                    {errorFor("alerts")}
                    {!data.mailConfigured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noMailTitle")}>
                        <Trans i18nKey="security.alertsNoMailBody" ns="controlAdmin" components={{ lnk: emailLink }} />
                      </MessageBox>
                    )}
                    {proxyUnset && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.ipsInaccurateTitle")}>
                        <Trans i18nKey="security.ipsInaccurateBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    <GroupedList id="deletion-protection" title={t("controlAdmin:security.deletesTitle")} note={t("controlAdmin:security.deletesDesc")}>
                      <ToggleRow
                        label={t("controlAdmin:security.deletesLabel")}
                        sub={t("controlAdmin:security.deletesHelp")}
                        checked={policyForm.trustedDeletesOnly}
                        disabled={busy}
                        onChange={(next) => void savePolicy("deletes", { trustedDeletesOnly: next })}
                      />
                    </GroupedList>
                    {errorFor("deletes")}
                    {policyForm.trustedDeletesOnly && data.trustedNetworks.length === 0 && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noTrustedTitle")}>
                        {t("controlAdmin:security.noTrustedBody")}
                      </MessageBox>
                    )}

                    <GroupedList id="device-linking" title={t("controlAdmin:security.devicesTitle")} note={t("controlAdmin:security.devicesDesc")}>
                      <CheckRow
                        label={t("controlAdmin:security.devicesLocalLabel")}
                        sub={t("controlAdmin:security.devicesLocalHelp")}
                        checked={policyForm.deviceLinkScope === "local"}
                        disabled={busy}
                        onSelect={() => { if (policyForm.deviceLinkScope !== "local") void savePolicy("devices", { deviceLinkScope: "local" }); }}
                      />
                      <CheckRow
                        label={t("controlAdmin:security.devicesAnyLabel")}
                        sub={t("controlAdmin:security.devicesAnyHelp")}
                        checked={policyForm.deviceLinkScope === "any"}
                        disabled={busy}
                        onSelect={() => { if (policyForm.deviceLinkScope !== "any") void savePolicy("devices", { deviceLinkScope: "any" }); }}
                      />
                    </GroupedList>
                    <GroupedList>
                      <ToggleRow
                        label={t("controlAdmin:security.devicesAlertLabel")}
                        sub={t("controlAdmin:security.devicesAlertHelp")}
                        checked={policyForm.alertAdminsDeviceLinked}
                        disabled={busy}
                        onChange={(next) => void savePolicy("devices", { alertAdminsDeviceLinked: next })}
                      />
                    </GroupedList>
                    {errorFor("devices")}
                    {policyForm.alertAdminsDeviceLinked && !data.mailConfigured && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.noMailTitle")}>
                        <Trans i18nKey="security.alertsNoMailBody" ns="controlAdmin" components={{ lnk: emailLink }} />
                      </MessageBox>
                    )}
                    {proxyUnset && (
                      <MessageBox tone="warning" title={t("controlAdmin:security.linkRefusedTitle")}>
                        <Trans i18nKey="security.linkRefusedBody" ns="controlAdmin" components={{ cd: <code /> }} />
                      </MessageBox>
                    )}

                    <GroupedList id="password-policy" title={t("controlAdmin:security.pwTitle")} note={t("controlAdmin:security.pwDesc")}>
                      <InputRow
                        label={t("controlAdmin:security.pwMinLabel")}
                        sub={t("controlAdmin:security.pwMinHelp")}
                        type="number"
                        min={8}
                        max={128}
                        value={Number.isNaN(pwForm.minLength) ? "" : String(pwForm.minLength)}
                        unit={t("controlAdmin:security.unitChars", { count: pwForm.minLength || 0 })}
                        disabled={savingPw}
                        onChange={(value) => setPwForm({ ...pwForm, minLength: value === "" ? Number.NaN : Number(value) })}
                        onCommit={commitPwMin}
                      />
                      <ToggleRow
                        label={t("controlAdmin:security.pwMixLabel")}
                        sub={t("controlAdmin:security.pwMixHelp")}
                        checked={pwForm.requireComplexity}
                        disabled={savingPw}
                        onChange={(next) => void savePwPolicy({ requireComplexity: next })}
                      />
                    </GroupedList>
                    {pwError && <MessageBox tone="error" title={t("errors.unableToSave")}>{pwError}</MessageBox>}

                    <GroupedList
                      id="ip-reputation"
                      title={t("controlAdmin:security.repTitle")}
                      note={<>{t("controlAdmin:security.repDesc")} {t("controlAdmin:security.repKeyHelp")}</>}
                    >
                      <InputRow
                        label={t("controlAdmin:security.repKeyLabel")}
                        type="password"
                        value={abuseKeyInput}
                        placeholder={policyForm.hasAbuseIpdbKey ? t("controlAdmin:security.repKeyPlaceholder") : ""}
                        onChange={setAbuseKeyInput}
                        wide
                      />
                      {abuseKeyInput.trim() && (
                        <ActionRow
                          label={savingPolicy === "reputation" ? t("controlAdmin:ui.saving") : t("controlAdmin:security.repKeySave")}
                          disabled={busy}
                          onClick={() => void savePolicy("reputation", {}, abuseKeyInput.trim())}
                        />
                      )}
                      {policyForm.hasAbuseIpdbKey && !abuseKeyInput.trim() && (
                        <ActionRow tone="danger" label={t("controlAdmin:security.removeSavedKey")} disabled={busy} onClick={() => void removeAbuseKey()} />
                      )}
                    </GroupedList>
                    <GroupedList>
                      <ToggleRow
                        label={t("controlAdmin:security.repEscalateLabel")}
                        sub={t("controlAdmin:security.repEscalateHelp")}
                        checked={policyForm.reputationAutoEscalate}
                        disabled={busy}
                        onChange={(next) => void savePolicy("reputation", { reputationAutoEscalate: next })}
                      />
                      <InputRow
                        label={t("controlAdmin:security.repThresholdRow")}
                        sub={t("controlAdmin:security.repThresholdHelp")}
                        type="number"
                        min={50}
                        max={100}
                        value={num("reputationEscalateThreshold")}
                        unit={t("controlAdmin:security.unitScore")}
                        onChange={setNum("reputationEscalateThreshold")}
                        onCommit={() => commitNumber("reputation", "reputationEscalateThreshold", 50, 100)}
                      />
                    </GroupedList>
                    {errorFor("reputation")}
                  </div>
                );
              })()}
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

              {/* Moved to its own tab in phase 5 (docs/photo-sync-plan.md); said here so
                  whoever looks for it beside the trusted networks finds the way. */}
              <p className="section-description">
                <Trans
                  i18nKey="phoneSyncPage.movedNote"
                  ns="controlAdmin"
                  components={{ link: <a href={controlHref("phoneSync")} onClick={(event) => followRoute(event, controlHref("phoneSync"))} /> }}
                />
              </p>
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
                      <Button
                        variant="chip"
                        key={kind}
                        className={`device-type-chip${blockFilter === kind ? " is-active" : ""}`}
                        aria-pressed={blockFilter === kind}
                        onClick={() => {
                          setBlockFilter(blockFilter === kind ? "all" : kind);
                          setBlockPage(1);
                        }}
                      >
                        <strong>{blockCounts[kind]}</strong> {t(`controlAdmin:security.${wordKey}`)}
                      </Button>
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
